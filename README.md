---
title: SailingMedAdvisor
emoji: ⛵
colorFrom: blue
colorTo: indigo
sdk: docker
pinned: false
---

# 🏥 SailingMedAdvisor - Offshore Medical AI Assistant

**Version:** 5.7 MVP (Security-Lite Edition)

An AI-powered medical triage and inquiry system designed for isolated offshore/sailing environments using Google's MedGemma models.

## 🚀 Quick Start

### Prerequisites
- Python 3.8+
- CUDA-capable GPU (recommended) or CPU
- 8GB+ RAM (16GB+ recommended for 28B model)

### Installation

1. **Clone or navigate to the project directory**
```bash
cd /home/rick/SailingMedAdvisor
```

2. **Create virtual environment**
```bash
python3 -m venv .venv
source .venv/bin/activate
```

3. **Install dependencies**
```bash
pip install flask torch transformers werkzeug
```

4. **Run the application**
```bash
chmod +x run_med_advisor.sh
./run_med_advisor.sh
```

5. **Access the system**
- Open browser: `http://127.0.0.1:5000` (or use your machine's IP for network access)
- Default password: `sailing2026`

**Network Access**: The server binds to `0.0.0.0:5000`, making it accessible from other devices on your local network. Access via `http://[YOUR-IP]:5000` from other devices. Ensure your network is trusted!

## 🔐 Security Features (NEW)

### What Was Added
✅ **Password Authentication** - Login required before accessing medical data  
✅ **Input Validation** - Prevents path traversal attacks  
✅ **Session Management** - Secure Flask sessions with secret keys  
✅ **Network Access** - Server accessible on local network (0.0.0.0:5000)  
✅ **Error Handling** - Proper exception handling throughout  
✅ **Safe Startup Script** - Removed dangerous system commands  

### Change Default Password
```bash
export ADMIN_PASSWORD='your_secure_password'
./run_med_advisor.sh
```

### Change Secret Key (Optional)
```bash
export SECRET_KEY='your_random_secret_key'
```

## 📋 Features

### Core Functionality
- **🚨 Triage Mode**: Clinical emergency assessment with protocols
- **📘 Inquiry Mode**: Academic medical research queries
- **👥 Crew Management**: Track patient histories and medical records
- **💊 Pharmacy Inventory**: Manage available medications
- **🔧 Equipment Tracking**: Monitor medical equipment availability
- **📜 Consultation History**: Logged interactions (with privacy toggle)
- **🔴 Privacy Mode**: Disable logging for sensitive consultations

### AI Models
- **4B Model**: `google/medgemma-1.5-4b-it` (Faster, lower resource)
- **28B Model**: `google/medgemma-1.5-28b-it` (More accurate, higher resource)

## 📁 Project Structure

```
SailingMedAdvisor/
├── app.py                    # Flask backend with authentication
├── run_med_advisor.sh        # Secure startup script
├── templates/
│   ├── index.html           # Main application UI
│   └── login.html           # Login page (NEW)
├── data/
│   ├── patients.json        # Crew medical histories
│   ├── inventory.json       # Medication inventory
│   ├── tools.json           # Equipment list
│   ├── history.json         # Consultation logs
│   ├── settings.json        # AI configuration
│   └── chats.json           # Reserved for future use
└── uploads/                  # Reserved for image uploads
```

## 🔧 Configuration

### AI Parameters (Settings Tab)

**Triage Mode:**
- Temperature: 0.1 (focused, deterministic responses)
- Max Tokens: 1024 (concise protocols)
- Top-P: 0.9

**Inquiry Mode:**
- Temperature: 0.6 (balanced creativity)
- Max Tokens: 2048 (detailed explanations)
- Top-P: 0.95

### System Prompts
Edit instructions in the CONFIG tab to customize AI behavior for your specific needs.

## 🩺 Usage Guide

### 1. Triage Station
- Select patient from crew manifest
- Enter clinical observations
- AI provides assessment + protocol + red flags
- Consultations auto-logged (unless privacy mode active)

### 2. Crew Management
- Add crew members with medical histories
- Edit and save patient profiles
- Track allergies, conditions, medications

### 3. Pharmacy & Equipment
- Add medications to inventory
- Track available medical equipment
- Referenced in triage assessments

### 4. History
- View past consultations
- Markdown-formatted responses
- Collapsible entries by date

## ⚠️ Important Notes

### Medical Disclaimer
**This is an AI assistant tool, NOT a replacement for professional medical care.**
- AI responses may be incorrect or incomplete
- Always seek professional medical help when available
- For emergencies: Use VHF/AIS/EPIRB as appropriate

### Data Privacy
- All data stored locally in JSON files (unencrypted)
- Use privacy mode for sensitive consultations
- Backup `data/` folder regularly
- Consider encrypting the data folder if storing on portable media

### Resource Requirements
- **4B Model**: ~8GB RAM, runs on CPU/GPU
- **28B Model**: ~16GB RAM, GPU strongly recommended
- First model load takes several minutes

## 🐛 Troubleshooting

### Login Issues
- Check password: default is `sailing2026`
- Clear browser cookies/cache
- Check terminal for error messages

### Model Loading Errors
```bash
# Check if transformers installed
pip install --upgrade transformers torch

# Check CUDA availability
python3 -c "import torch; print(torch.cuda.is_available())"
```

### Port Already in Use
```bash
# Find and kill process on port 5000
lsof -ti:5000 | xargs kill -9
```

## 📈 Roadmap (Future Enhancements)

### Phase 2 - Core MVP Extensions
- [ ] Image upload support (for wounds, rashes, etc.)
- [ ] PDF export of consultations
- [ ] Offline PWA support

### Phase 3 - Polish
- [ ] Mobile-responsive improvements
- [ ] Print-friendly reports
- [ ] Data encryption at rest

### Phase 4 - Advanced
- [ ] Multi-user support
- [ ] Symptom checker wizard
- [ ] Medication interaction warnings
- [ ] Integration with medical databases

## 📝 Changelog

### v5.7 MVP (Security-Lite Edition) - 2026-01-18
**Security Improvements:**
- ✅ Added password authentication system
- ✅ Implemented session management
- ✅ Added input validation (path traversal prevention)
- ✅ Maintained 0.0.0.0 binding for local network access
- ✅ Removed dangerous sudo commands from startup script
- ✅ Added comprehensive error handling

**Bug Fixes:**
- ✅ Fixed missing JavaScript functions (addCrew, saveProfile, delItem)
- ✅ Fixed settings schema mismatch
- ✅ Added inventory/equipment CRUD functionality
- ✅ Fixed undefined history field handling

**Documentation:**
- ✅ Created comprehensive README
- ✅ Added security documentation
- ✅ Added troubleshooting guide

### v5.6 and Earlier
- Original prototype with core AI chat functionality
- Triage and inquiry modes
- Patient/inventory/tool tracking

## 🤝 Contributing

This is a personal project, but suggestions are welcome:
1. Test the system thoroughly
2. Report bugs via `/reportbug` command
3. Suggest improvements

## 📜 License

Private use only. Contains Google MedGemma models which have their own usage terms.

## 🔗 Resources

- [MedGemma Documentation](https://huggingface.co/google/medgemma-1.5-4b-it)
- [Flask Documentation](https://flask.palletsprojects.com/)
- [Transformers Library](https://huggingface.co/docs/transformers/)

---

**Stay safe on the water! ⛵🏥**
