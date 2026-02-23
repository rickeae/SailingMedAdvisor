# SailingMedAdvisor  
## Offline Emergency Decision Support for Offshore Crews Using MedGemma

**One-Sentence Summary:**  
SailingMedAdvisor is a clinical decision-support system for offshore sailing vessels, powered by Google’s MedGemma models from the Health AI Developer Foundations (HAI-DEF), operating on edge hardware without reliable internet access.

### Project name

SailingMedAdvisor

### Your team: Rick Escher (solo project lead)
Captain of **s/v Aphrodite** since 2015, with direct operational responsibility for offshore safety, medical decision-making, and emergency logistics. Background in physics and space science (**M.S. in Space Science**). Former founder of **Recognia Inc.** (now TradingCentral.com).

**Role in this project:** problem definition, system architecture, product design, implementation, prompt pathway design, offline deployment/testing, and clinical workflow validation against real offshore scenarios.

---

### Problem statement

Offshore sailing vessels routinely operate hundreds or thousands of miles from the nearest hospital. During ocean passages there is no reliable internet connectivity, no rapid evacuation capability, and often no professional medical assistance available. The crew must manage traumatic injuries, infections, allergic reactions, burns, embedded objects, and other acute medical conditions using only the limited supplies stored onboard. Under the principles of SOLAS and longstanding maritime law, the captain bears ultimate responsibility for the health and safety of all persons aboard, including the provision of reasonable medical care within the vessel’s operational constraints.

Most AI healthcare tools assume constant internet access or centralized cloud infrastructure. That assumption fails in maritime, polar, wilderness, and disaster-response environments. In these settings, privacy and autonomy are equally critical: crew medical history should not leave the vessel, and treatment guidance must function entirely offline.

The core problem addressed by this project is:

> **Can a clinically capable large language model support structured emergency reasoning fully offline, on edge hardware, while respecting supply constraints, privacy, and distance from definitive care?**

SailingMedAdvisor demonstrates that MedGemma can operate in constrained, real-world, non-cloud environments and provide structured, context-aware decision support during medical events at sea.

---

### Impact potential

In a local pilot snapshot (as of 2026-02-23), the system shows measurable operational impact for offshore decision support:

- **Sustained use, not one-off demo:** **114 completed consultations** were recorded locally (`109` on 4B, `5` on 27B).
- **Fast first-pass guidance option:** 4B averaged **102.2 seconds** per run, enabling near-real-time initial triage support.
- **Structured emergency framing:** retained consultation responses included an evacuation-state marker (`STAY`, `URGENT`, or `IMMEDIATE`) in **9/9** reviewed cases.

**Method:** metrics were computed from local SQLite tables (`chat_metrics`, `history_entries`) using run counts, duration fields, and response-text pattern checks. No external telemetry was used.

---

### Overall solution

SailingMedAdvisor integrates Google’s MedGemma models into a structured triage workflow that:

1. Runs entirely offline on a local machine (for this project a Lenovo P53 with an NVIDIA Quadro RTX 5000 GPU).
2. Uses a hierarchical clinical triage pathway to constrain reasoning.
3. Incorporates onboard medical inventory into the prompt.
4. Stores all patient and vessel data locally in SQLite.
5. Avoids network calls during inference.

The system supports two reasoning modes:

- **General Triage Mode:** Used when limited structured inputs are provided.
- **Pathway-Specific Mode:** Activated when structured triage inputs are provided.

When structured inputs are supplied, the system dynamically assembles a pathway-specific prompt composed of modular clinical instruction blocks. This increases reasoning specificity and reduces generic or irrelevant recommendations.

Inference is performed locally using:

- `google/medgemma-1.5-4b-it`
- `google/medgemma-27b-text-it`

No cloud APIs are used during runtime.

---

### Technical details

## Inputs and Data Handling

There is no external dataset. The system operates on structured and contextual inputs including:

- Triage dropdown selections  
- Patient condition indicators (Consciousness, Breathing, Circulation, Stability)  
- Crew medical history  
- Vessel-specific operational constraints (crew size, sea state, power, environment, evacuation feasibility)  
- Onboard medical inventory (medications, procedural supplies, monitoring tools)  
- Distance from definitive care  

All data is stored locally in `app.db` (SQLite).

---

## Prompt Construction Strategy

Act as a Trauma Surgeon. You are in Trauma Mode. Rule out physiological failure before addressing anatomical appearance. Do not provide wound care instructions until you have confirmed Airway, Breathing, and Circulation (ABC) stability.
The system now uses a hierarchical prompt assembly approach:

1. User selects structured triage categories:
   - Domain (Trauma, Medical Illness, Environmental, Dental, Psychological)
   - Problem Type
   - Anatomy
   - Mechanism/Cause
   - Severity/Complication

2. The system maps selections to predefined clinical prompt modules.

3. Modules are combined with:
   - Structured inventory constraints (pharmaceuticals, equipment, consumables)
   - Distance-from-care context
   - Structured emergency safety framework (airway, breathing, bleeding checks, and evacuation thresholds)
   - Clarifying question templates

4. If the pathway is incomplete, the system falls back to a general triage framework.

This structured assembly improves:

- Clinical specificity  
- Operational alignment  
- Supply awareness  
- Reduction of generic responses  

---
### Inventory Constraints

Onboard medical inventory is structured into three operational categories:

1. **Pharmaceuticals** – antibiotics, analgesics, antiemetics, epinephrine, antiparasitics, and controlled medications.  
2. **Equipment** – suturing kits, irrigation devices, splints, monitoring tools, dental repair materials, and procedural instruments.  
3. **Consumables** – gauze, sterile saline, gloves, dressings, syringes, and other expendable supplies.  

Recommendations are constrained to what is physically available onboard. This prevents unrealistic or non-executable guidance and ensures that suggested interventions are operationally feasible in a remote maritime environment.

Because vessels routinely enter new jurisdictions, controlled medications must be tracked, declared, and reconciled for customs and immigration authorities. The system includes structured controlled-substance logging not only for clinical accountability but also to support regulatory compliance during international clearance procedures.

#### Operational Continuity and System Reliability

Additional vessel and crew management features were integrated intentionally. The system includes:

- Vessel documentation records  
- Crew list management including passport information, vaccine history and photographs  
- Controlled medicine logs  
- Export tools for immigration and customs documentation  

These capabilities serve dual purposes.

First, they support real operational requirements during international clearance.

Second, they ensure the software is used regularly between medical events. In remote environments, infrequently used computer systems risk becoming outdated or misconfigured. By embedding high-frequency operational tasks into the platform, SailingMedAdvisor remains active, validated, and familiar to users. This reduces startup friction and increases reliability during times of actual emergency.

Together, structured pathway logic, inventory constraint modeling, stabilization scaffolding, and operational integration allow MedGemma to function as a context-aware clinical reasoning engine within the practical realities of offshore sailing.

---
## Model Integration

MedGemma is loaded using Hugging Face Transformers with runtime-selectable parameters:

- Temperature  
- Top-p  
- Top-k  
- Max new tokens  

The inference adapters (`medgemma4.py`, `medgemma27b.py`), with shared helpers in `medgemma_common.py`, standardize prompt formatting, device handling, and token budgeting for consistent behavior. When sampling is enabled, outputs are not strictly deterministic.

Startup logic performs:

- CUDA preflight validation  
- Configurable GPU memory caps and placement constraints  
- Optional CPU fallback control (disabled by default)  
- Explicit failure if GPU is unavailable when `FORCE_CUDA=1`  

Inference runs locally in edge deployment mode. A separate remote-inference path exists only when local inference is explicitly disabled (for example, hosted mode).

---

### Reproducibility (initial results)

- Public repository: https://github.com/rickeae/SailingMedAdvisor
- Pinned code snapshot for this submission: `de93f406d161b832482494b9c90b4f2578e3a85a`
- Models used: `google/medgemma-1.5-4b-it`, `google/medgemma-27b-text-it`

#### Setup and run

```bash
git clone https://github.com/rickeae/SailingMedAdvisor.git
cd SailingMedAdvisor
git checkout de93f406d161b832482494b9c90b4f2578e3a85a
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
chmod +x run_med_advisor.sh
./run_med_advisor.sh
```

Open: `http://127.0.0.1:5000`

#### Reproduce the demo scenario

1. Select **Triage Consultation** mode.
2. Select model: **google/medgemma-27b-text-it**.
3. Enter the fish-hook cheek scenario shown in the demo.
4. Select the matching clinical pathway values shown in the demo.
5. Submit and compare the returned guidance structure to the video.

---

# Architecture & Components

## High-Level Workflow

1. Captain/crew enters scenario details and optional triage pathway selections.  
2. System assembles a mode-specific prompt (general triage or pathway-specific triage).  
3. Prompt is augmented with onboard inventory and relevant vessel/crew context.  
4. MedGemma runs locally and returns structured guidance.  
5. Result is displayed and optionally stored in the consultation log for replay/review.  

---

## Core Components

**Backend**
- Python
- FastAPI
- SQLite

**Models**
- MedGemma 1.5 4B
- MedGemma 27B

**Frontend**
- HTML templates
- JavaScript
- Structured triage dropdowns

**Inference Pipeline**
- Hugging Face Transformers
- CUDA acceleration
- Parameterized sampling

**Edge Constraints**
- No external API calls in edge deployment mode
- No telemetry
- No remote logging
- Fully local state persistence

---

# Demo and Results

The demonstration presents a real offshore scenario: a barbed fish hook embedded in a child’s cheek in a remote harbor in the Solomon Islands. Patient identifiers are fictionalized, but the medical scenario reflects an actual offshore event.

Observed system behaviors:

- Network disabled during inference.
- GPU utilization rises to 100%, confirming local execution.
- MedGemma returns:
  - Structured triage summary
  - Initial assessment
  - Stabilization plan
  - Procedural considerations
  - Clarifying questions

When the structured pathway is selected:

The generated guidance becomes more anatomy-specific, mechanism-aware, and inventory-constrained than in generic triage mode, reducing irrelevant recommendations.

The resulting guidance is anatomy-specific, operationally constrained, and supply-aware.

Evaluation is qualitative and scenario-based, focusing on:

- Structured output consistency  
- Offline reliability  
- Clinical coherence  
- Operational realism  

### Measured feasibility results (pilot)

| Metric | 4B (`google/medgemma-1.5-4b-it`) | 27B (`google/medgemma-27b-text-it`) | Measurement source |
| --- | ---: | ---: | --- |
| Logged completed runs | 109 | 5 | `chat_metrics.count` |
| Mean response time | 102.2 s | 2,904.9 s (48.4 min) | `chat_metrics.avg_ms` |
| Retained-log median response time | 53.4 s (n=7) | 3,476.6 s (n=1) | `history_entries.duration_ms` |
| Retained-log P95 response time | 109.4 s (n=7) | 3,476.6 s (n=1) | `history_entries.duration_ms` |
| Non-empty response rate (retained log) | 7/7 (100%) | 2/2 (100%) | `history_entries.response` |

**Method note:** `history_entries` currently contains a pruned subset (9 records). The `chat_metrics` table captures aggregate throughput across a larger run set.

The system demonstrates that MedGemma can perform context-constrained clinical reasoning entirely at the edge.

---

# Final Model Description

The final configuration uses:

- MedGemma 1.5 4B for lightweight deployment
- MedGemma 27B for higher-fidelity reasoning
- No fine-tuning
- Hierarchical prompt assembly
- Controlled generation parameters

Validation strategy:

- Structured vs unstructured prompt comparison
- Pathway-specific vs general reasoning evaluation
- Multiple real-world offshore case simulations
- GPU-only execution validation

There is no leaderboard dataset; evaluation focuses on feasibility, reproducibility, and real-world applicability.

---

# Sources / References

- Google Health AI Developer Foundations (HAI-DEF)
- MedGemma model collection (Hugging Face)
- Hugging Face Transformers
- FastAPI documentation
- SQLite documentation
- CUDA runtime documentation
- Public code repository: https://github.com/rickeae/SailingMedAdvisor

All models are used in accordance with HAI-DEF Terms of Use.

---

# Future Work

Planned enhancements include:

- Structured risk scoring overlay  
- Dosage calculation module  
- Formal evacuation threshold classifier  
- Offline PDF export of consultations  
- Multilingual support  
- Model distillation for lower-power hardware  
- Structured evaluation against maritime medical manuals  

Long-term applications extend beyond sailing vessels to:

- Remote research stations  
- Disaster response environments  
- Wilderness expeditions  
- Rural mobile clinics  

---

# Conclusion

SailingMedAdvisor demonstrates that MedGemma can operate as a structured clinical decision-support engine entirely at the edge.

The system runs fully offline, keeps all patient data local, integrates operational constraints, and delivers structured medical reasoning tailored to offshore emergencies.

This project shows that high-fidelity medical AI does not require cloud infrastructure to be effective. In constrained environments where internet access is unavailable and evacuation may be delayed, MedGemma can function as a privacy-preserving, operationally grounded clinical reasoning system.
