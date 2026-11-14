#!/usr/bin/env python3
"""Export scenario definitions to JSON for the TypeScript generator."""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scenario as S

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "seed")
os.makedirs(OUT, exist_ok=True)

payload = dict(
    companies=S.COMPANIES, persons=S.PERSONS, timeline=S.TIMELINE,
    relations=S.RELATIONS, nonEquityChanges=S.NON_EQUITY_CHANGES,
    snapshotDates=dict(S.SNAPSHOT_DATES),
)
json.dump(payload, open(os.path.join(OUT, "scenario.json"), "w"), ensure_ascii=False, indent=2)
print("wrote", os.path.join(OUT, "scenario.json"), "companies", len(S.COMPANIES), "persons", len(S.PERSONS))
