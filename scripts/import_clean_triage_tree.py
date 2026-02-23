#!/usr/bin/env python3
# =============================================================================
# Author: Rick Escher
# Project: SailingMedAdvisor
# Context: Google HAI-DEF Framework
# Models: Google MedGemmas
# Program: Kaggle Impact Challenge
# =============================================================================
"""
Import the clean hierarchical triage tree into SailingMedAdvisor's runtime schema.

Input schema (clean, editable):
{
  "tree_version": "1.0",
  "domain": {
    "Trauma": {
      "presentation": {
        "Laceration": {
          "region_or_system": {
            "Head": {
              "condition_state": [...],
              "risk_modifier": [...]
            }
          }
        }
      }
    }
  }
}

Runtime schema (current app expects):
{
  "base_doctrine": "...",
  "tree": {
    "Trauma": {
      "mindset": "...",
      "problems": {
        "Laceration": {
          "procedure": "...",
          "exclusions": "...",
          "anatomy_guardrails": {"Head": "..."},
          "severity_modifiers": {"Stable": "..."},
          "mechanism_modifiers": {"Fall mechanism": "..."}
        }
      }
    }
  }
}
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import db_store


DEFAULT_BASE_DOCTRINE = (
    "You are SailingMedAdvisor. Role: Damage-control for Vessel Captain. "
    "Priority: MARCH-PAWS. Rules: Numbered imperative steps, timed reassessment intervals, "
    "no speculation, only Medical Chest items. For Ethan: weight-based dosing. "
    "Output: STAY, URGENT, or IMMEDIATE."
)

DOMAIN_MINDSETS = {
    "Trauma": "Physiology over appearance. Stabilize first. Order: Hemostasis -> Airway -> Breathing -> Circulation.",
    "Medical Illness": "Vitals trends and treatment response only. Avoid rare/complex diagnoses.",
    "Environmental": "Neutralize the pathogen (environment) first.",
    "Dental": "Preservation only. No extractions unless airway is threatened.",
    "Behavioral": "Vessel safety first. Secure the environment; avoid chemical restraint.",
}

DOMAIN_ALIASES = {
    "medical illness": "Medical Illness",
    "behavioral / psychological": "Behavioral",
}


def norm(value: Any) -> str:
    """
    Norm helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


def first_existing_key(options: Dict[str, Any], wanted: str) -> Optional[str]:
    """
    First Existing Key helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    if not isinstance(options, dict) or not wanted:
        return None
    if wanted in options:
        return wanted
    w = norm(wanted)
    for key in options.keys():
        if norm(key) == w:
            return key
    return None


def as_list(values: Any) -> List[str]:
    """
    As List helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    if not isinstance(values, list):
        return []
    seen = set()
    out: List[str] = []
    for v in values:
        s = str(v or "").strip()
        if not s:
            continue
        n = norm(s)
        if n in seen:
            continue
        seen.add(n)
        out.append(s)
    return out


def choose_text(
    existing_map: Dict[str, Any],
    key: str,
    fallback: str,
) -> str:
    """
    Choose Text helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    if isinstance(existing_map, dict):
        hit = first_existing_key(existing_map, key)
        if hit and isinstance(existing_map.get(hit), str) and existing_map.get(hit).strip():
            return existing_map.get(hit).strip()
    return fallback


def convert_clean_to_runtime(
    clean: Dict[str, Any],
    existing_runtime: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Convert Clean To Runtime helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    clean_domains = clean.get("domain")
    if not isinstance(clean_domains, dict) or not clean_domains:
        raise ValueError("Input clean JSON must contain a non-empty 'domain' object.")

    existing_tree = existing_runtime.get("tree") if isinstance(existing_runtime, dict) else {}
    if not isinstance(existing_tree, dict):
        existing_tree = {}

    base_doctrine = (clean.get("base_doctrine") or "").strip()
    if not base_doctrine:
        base_doctrine = (existing_runtime.get("base_doctrine") or "").strip() if isinstance(existing_runtime, dict) else ""
    if not base_doctrine:
        base_doctrine = DEFAULT_BASE_DOCTRINE

    runtime_tree: Dict[str, Any] = {}
    for raw_domain_name, domain_payload in clean_domains.items():
        if not isinstance(domain_payload, dict):
            continue
        domain_name = str(raw_domain_name or "").strip()
        if not domain_name:
            continue

        canonical_domain = DOMAIN_ALIASES.get(domain_name.lower(), domain_name)
        existing_domain_key = first_existing_key(existing_tree, canonical_domain) or first_existing_key(existing_tree, domain_name)
        existing_domain = existing_tree.get(existing_domain_key, {}) if existing_domain_key else {}
        existing_problems = existing_domain.get("problems") if isinstance(existing_domain, dict) else {}
        if not isinstance(existing_problems, dict):
            existing_problems = {}

        mindset = (domain_payload.get("mindset") or "").strip()
        if not mindset:
            if isinstance(existing_domain, dict):
                mindset = (existing_domain.get("mindset") or "").strip()
        if not mindset:
            mindset = DOMAIN_MINDSETS.get(canonical_domain, "")

        clean_presentations = domain_payload.get("presentation")
        if not isinstance(clean_presentations, dict):
            clean_presentations = {}

        problems_out: Dict[str, Any] = {}
        for raw_presentation_name, presentation_payload in clean_presentations.items():
            if not isinstance(presentation_payload, dict):
                continue
            presentation_name = str(raw_presentation_name or "").strip()
            if not presentation_name:
                continue

            existing_problem_key = first_existing_key(existing_problems, presentation_name)
            existing_problem = existing_problems.get(existing_problem_key, {}) if existing_problem_key else {}
            if not isinstance(existing_problem, dict):
                existing_problem = {}

            procedure = (presentation_payload.get("procedure") or "").strip()
            if not procedure:
                procedure = (existing_problem.get("procedure") or "").strip()
            if not procedure:
                procedure = (
                    f"Manage {presentation_name} under {canonical_domain} pathway. "
                    "Use selected region/system, condition state, and risk modifier to drive step priorities."
                )

            exclusions = (presentation_payload.get("exclusions") or "").strip()
            if not exclusions:
                exclusions = (existing_problem.get("exclusions") or "").strip()

            existing_anatomy = existing_problem.get("anatomy_guardrails") if isinstance(existing_problem, dict) else {}
            existing_severity = existing_problem.get("severity_modifiers") if isinstance(existing_problem, dict) else {}
            existing_mechanism = existing_problem.get("mechanism_modifiers") if isinstance(existing_problem, dict) else {}
            if not isinstance(existing_anatomy, dict):
                existing_anatomy = {}
            if not isinstance(existing_severity, dict):
                existing_severity = {}
            if not isinstance(existing_mechanism, dict):
                existing_mechanism = {}

            anatomy_guardrails: Dict[str, str] = {}
            severity_modifiers: Dict[str, str] = {}
            mechanism_modifiers: Dict[str, str] = {}

            region_map = presentation_payload.get("region_or_system")
            if not isinstance(region_map, dict):
                region_map = {}

            for raw_region_name, region_payload in region_map.items():
                region_name = str(raw_region_name or "").strip()
                if not region_name:
                    continue
                region_obj = region_payload if isinstance(region_payload, dict) else {}

                anatomy_guardrails[region_name] = choose_text(
                    existing_anatomy,
                    region_name,
                    (
                        f"Focus region/system: {region_name}. Prioritize site-specific risks, trend changes, "
                        "and reassessment intervals aligned with selected condition and risk modifiers."
                    ),
                )

                for state_name in as_list(region_obj.get("condition_state")):
                    if state_name in severity_modifiers:
                        continue
                    severity_modifiers[state_name] = choose_text(
                        existing_severity,
                        state_name,
                        (
                            f"Condition state: {state_name}. Escalate urgency based on trend and response; "
                            "repeat focused reassessment at short intervals."
                        ),
                    )

                for risk_name in as_list(region_obj.get("risk_modifier")):
                    if risk_name in mechanism_modifiers:
                        continue
                    mechanism_modifiers[risk_name] = choose_text(
                        existing_mechanism,
                        risk_name,
                        (
                            f"Risk modifier: {risk_name}. Adjust monitoring window, hidden-injury suspicion, "
                            "and evacuation threshold accordingly."
                        ),
                    )

            problems_out[presentation_name] = {
                "procedure": procedure,
                "exclusions": exclusions,
                "anatomy_guardrails": anatomy_guardrails,
                "severity_modifiers": severity_modifiers,
                "mechanism_modifiers": mechanism_modifiers,
            }

        if problems_out:
            runtime_tree[canonical_domain] = {
                "mindset": mindset,
                "problems": problems_out,
            }

    if not runtime_tree:
        raise ValueError("Converted runtime tree is empty; check input JSON content.")

    return {
        "base_doctrine": base_doctrine,
        "tree": runtime_tree,
    }


def main() -> int:
    """
    Main helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    parser = argparse.ArgumentParser(description="Import clean hierarchical triage tree JSON into app runtime DB schema.")
    parser.add_argument("--input", required=True, help="Path to clean triage JSON (tree_version/schema/domain format).")
    parser.add_argument("--db", default="app.db", help="Path to SQLite database (default: app.db).")
    parser.add_argument("--preview-out", default="", help="Optional path to write converted runtime JSON preview.")
    parser.add_argument("--dry-run", action="store_true", help="Convert and validate, but do not write to DB.")
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        raise SystemExit(f"Input file not found: {input_path}")

    try:
        clean_payload = json.loads(input_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise SystemExit(f"Invalid JSON in {input_path}: {exc}") from exc

    db_store.configure_db(Path(args.db))
    existing = db_store.get_triage_prompt_tree() or {}
    converted = convert_clean_to_runtime(clean_payload, existing)

    if args.preview_out:
        preview_path = Path(args.preview_out)
        preview_path.write_text(json.dumps(converted, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Preview written: {preview_path}")

    tree = converted.get("tree", {})
    print(f"Converted domains: {len(tree)}")
    for domain_name, domain_node in tree.items():
        problems = domain_node.get("problems", {}) if isinstance(domain_node, dict) else {}
        print(f"- {domain_name}: problems={len(problems)}")

    if args.dry_run:
        print("Dry run only; DB not modified.")
        return 0

    saved = db_store.set_triage_prompt_tree(converted)
    saved_tree = saved.get("tree", {}) if isinstance(saved, dict) else {}
    print(f"Saved to DB: {args.db}")
    print(f"Saved domains: {len(saved_tree)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
