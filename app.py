import os
import json
import torch
import secrets
from datetime import datetime
from functools import wraps
from flask import Flask, render_template, request, jsonify, session, redirect, url_for
from werkzeug.security import generate_password_hash, check_password_hash
from transformers import AutoProcessor, AutoModelForImageTextToText

app = Flask(__name__)
app.config['DATA_DIR'] = 'data'
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY') or secrets.token_hex(32)
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB max upload
os.makedirs(app.config['DATA_DIR'], exist_ok=True)

# Simple password storage (you should change this on first run)
ADMIN_PASSWORD_HASH = generate_password_hash(os.environ.get('ADMIN_PASSWORD', 'sailing2026'))

device = "cuda" if torch.cuda.is_available() else "cpu"
dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
models = {"active_name": "", "model": None, "processor": None}

def load_model(model_name):
    if models["active_name"] == model_name:
        return
    models["processor"] = AutoProcessor.from_pretrained(model_name, use_fast=True)
    models["model"] = AutoModelForImageTextToText.from_pretrained(
        model_name, 
        torch_dtype=dtype, 
        device_map="auto" if device == "cuda" else None
    )
    models["active_name"] = model_name

def get_defaults():
    return {
        "triage_instruction": "Act as Lead Clinician. Priority: Life-saving protocols. Format: ## ASSESSMENT, ## PROTOCOL.",
        "inquiry_instruction": "Act as Medical Librarian. Focus: Academic research and pharmacology.",
        "tr_temp": 0.1,
        "tr_tok": 1024,
        "tr_p": 0.9,
        "in_temp": 0.6,
        "in_tok": 2048,
        "in_p": 0.95,
        "rep_penalty": 1.1,
        "mission_context": "Isolated Medical Station offshore."
    }

def db_op(cat, data=None):
    # Input validation to prevent path traversal
    allowed_categories = ['settings', 'patients', 'inventory', 'tools', 'history', 'chats', 'vessel']
    if cat not in allowed_categories:
        raise ValueError(f"Invalid category: {cat}")
    
    path = os.path.join(app.config['DATA_DIR'], f"{cat}.json")
    if not os.path.exists(path) or os.stat(path).st_size == 0:
        if cat == 'settings':
            content = get_defaults()
        elif cat == 'vessel':
            content = {
                "vesselName": "",
                "registrationNumber": "",
                "flagCountry": "",
                "homePort": "",
                "callSign": "",
                "tonnage": "",
                "crewCapacity": ""
            }
        else:
            content = []
        with open(path, 'w') as f:
            json.dump(content, f, indent=4)
    
    if data is not None:
        with open(path, 'w') as f:
            json.dump(data, f, indent=4)
        return data
    
    with open(path, 'r') as f:
        return json.load(f)

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not session.get('authenticated'):
            return jsonify({"error": "Authentication required"}), 401
        return f(*args, **kwargs)
    return decorated_function

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        password = request.form.get('password') or request.json.get('password')
        if check_password_hash(ADMIN_PASSWORD_HASH, password):
            session['authenticated'] = True
            return jsonify({"success": True})
        return jsonify({"error": "Invalid password"}), 401
    return render_template('login.html')

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))

@app.route('/')
def index():
    if not session.get('authenticated'):
        return redirect(url_for('login'))
    return render_template('index.html')

@app.route('/api/data/<cat>', methods=['GET', 'POST'])
@login_required
def manage(cat):
    try:
        if request.method == 'POST':
            return jsonify(db_op(cat, request.json))
        return jsonify(db_op(cat))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": "Server error"}), 500

@app.route('/api/chat', methods=['POST'])
@login_required
def chat():
    try:
        msg = request.form.get('message')
        p_name = request.form.get('patient')
        mode = request.form.get('mode')
        is_priv = request.form.get('private') == 'true'
        
        load_model(request.form.get('model_choice'))
        s = db_op('settings')
        
        if mode == 'inquiry':
            prompt = f"INSTRUCTION: {s.get('inquiry_instruction')}\n\nQUERY: {msg}"
            cfg = {
                "t": float(s.get('in_temp', 0.6)),
                "tk": int(s.get('in_tok', 2048)),
                "p": float(s.get('in_p', 0.95))
            }
        else:
            inv = ", ".join([m['name'] for m in db_op('inventory')])
            tools = ", ".join([t['name'] for t in db_op('tools')])
            p_hist = next(
                (p.get('history', 'No records.') for p in db_op('patients') if p['name'] == p_name),
                "No records."
            )
            prompt = f"RULES: {s.get('triage_instruction')}\nRESOURCES: {inv} | {tools}\nPATIENT: {p_name}\nHISTORY: {p_hist}\nSITUATION: {msg}"
            cfg = {
                "t": float(s.get('tr_temp', 0.1)),
                "tk": int(s.get('tr_tok', 1024)),
                "p": float(s.get('tr_p', 0.9))
            }

        inputs = models["processor"].apply_chat_template(
            [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
            add_generation_prompt=True,
            tokenize=True,
            return_dict=True,
            return_tensors="pt"
        ).to(models["model"].device)
        
        out = models["model"].generate(
            **inputs,
            max_new_tokens=cfg["tk"],
            temperature=cfg["t"],
            top_p=cfg["p"],
            repetition_penalty=1.1,
            do_sample=(cfg["t"] > 0)
        )
        
        res = models["processor"].decode(
            out[0][inputs["input_ids"].shape[-1]:],
            skip_special_tokens=True
        ).strip()
        
        if not is_priv:
            h = db_op('history')
            h.append({
                "id": datetime.now().isoformat(),
                "date": datetime.now().strftime("%Y-%m-%d %H:%M"),
                "patient": p_name if mode == 'triage' else 'Inquiry',
                "query": msg,
                "response": res
            })
            db_op('history', h)
        
        return jsonify({"response": res, "model": models["active_name"]})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    print("=" * 50)
    print("🏥 SailingMedAdvisor Starting...")
    print("=" * 50)
    print(f"Default password: sailing2026")
    print(f"Change via: export ADMIN_PASSWORD='your_password'")
    print(f"Access via: http://0.0.0.0:5000 (all network interfaces)")
    print("=" * 50)
    app.run(host='0.0.0.0', port=5000, debug=False)
