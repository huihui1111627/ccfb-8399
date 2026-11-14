#!/usr/bin/env python3
"""Build independently stored ground truth (true entity resolution + true controllers).

Uses dense linear algebra on the scenario's cap tables; the TypeScript app uses a
graph-propagation solver instead, so the two are genuine cross-checks.
"""
from __future__ import annotations
import json, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scenario as S

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "truth")
os.makedirs(OUT, exist_ok=True)


def table_at(company: str, date: str) -> dict[str, float]:
    rows = S.TIMELINE[company]
    active = [r for r in rows if r[0] <= date]
    if not active:
        return {}
    return dict(active[-1][1])


def cap_table_at(date: str) -> dict[str, dict[str, float]]:
    return {c: table_at(c, date) for c in S.TIMELINE}


def calc(tbl, date, threshold=0.30):
    cos = list(S.COMPANIES)
    idx = {c: i for i, c in enumerate(cos)}
    persons = list(S.PERSONS)
    n = len(cos)
    P = {p: np.zeros(n) for p in persons}
    C = np.zeros((n, n))
    for c, row in tbl.items():
        for holder, pct in row.items():
            if holder in P:
                P[holder][idx[c]] += pct
            else:
                C[idx[holder]][idx[c]] += pct
    for c in cos:
        j = idx[c]
        total = sum(P[p][j] for p in persons) + sum(C[i][j] for i in range(n))
        if abs(total - 1) > 1e-9:
            raise SystemExit(f"cap table {c} @ {date} sums to {total}")
    rel = [r for r in S.RELATIONS if r["start"] <= date and (r["end"] is None or date <= r["end"])]
    Padj = {p: P[p].copy() for p in persons}
    for r in rel:
        if r["type"] == "nominee":
            col = Padj[r["nominal"]][idx[r["scope"]]]
            Padj[r["nominal"]][idx[r["scope"]]] = 0
            Padj[r["actual"]][idx[r["scope"]]] += col
    inv = np.eye(n) - C.T
    U = {p: np.linalg.solve(inv, Padj[p]) for p in persons}
    Uleg = {p: np.linalg.solve(inv, P[p]) for p in persons}
    res = {}
    for c in cos:
        j = idx[c]
        eff = {p: float(U[p][j]) for p in persons}
        groups = []
        for r in rel:
            if r["type"] == "concert" and r["scope"] == c:
                pct = sum(eff[m] for m in r["members"])
                groups.append((pct, r["leader"], r["members"], r["id"]))
        groups.sort(key=lambda x: -x[0])
        top = max(eff.items(), key=lambda x: x[1])
        if groups and groups[0][0] >= threshold and groups[0][0] > top[1] + 1e-9:
            pct, leader, members, rid = groups[0]
            ctrl = dict(kind="group", leader=leader, members=sorted(members), pct=round(pct, 6),
                        relation_id=rid, basis=f"一致行动合计{pct:.2%}，牵头人{leader}")
        elif top[1] >= threshold:
            ctrl = dict(kind="person", leader=top[0], members=[top[0]], pct=round(top[1], 6),
                        relation_id=None, basis=f"直接及穿透持股{top[1]:.2%}")
        else:
            ctrl = dict(kind="none", leader=None, members=[], pct=round(top[1], 6),
                        relation_id=None, basis=f"股权分散，单一股东最高{top[1]:.2%}，不足30%")
        owners = sorted([(p, round(eff[p], 6)) for p in persons if eff[p] > 0.25 + 1e-9], key=lambda x: -x[1])
        res[c] = dict(
            controller=ctrl,
            beneficial_owners=[dict(person_id=p, pct=v) for p, v in owners],
            effective={p: round(eff[p], 6) for p in persons if eff[p] > 1e-6},
            legal_effective={p: round(float(Uleg[p][j]), 6) for p in persons if Uleg[p][j] > 1e-6},
            direct_holders={h: round(v, 6) for h, v in tbl[c].items()},
        )
    return res


def main():
    gt = {}
    for name, date in S.SNAPSHOT_DATES:
        gt[name] = dict(date=date, companies=calc(cap_table_at(date), date))
        print(f"{name} {date}: " + " ".join(
            f"{c}={gt[name]['companies'][c]['controller']['leader'] or 'None'}" for c in ("BLUE", "ZY", "QH", "QM")))
    json.dump(gt, open(os.path.join(OUT, "controllers.json"), "w"), ensure_ascii=False, indent=2)

    companies = []
    for key, m in S.COMPANIES.items():
        companies.append(dict(
            entity_id=f"CO_{key}", kind="company", key=key, canonical_name=m["name"],
            uscc=m["uscc"], short_name=m["short"], former_names=m["former"],
            address=m["addr"], legal_rep=m["legal"],
            aliases=[x for x in [m["name"], m["short"], *m["former"]] if x]))
    persons = [dict(entity_id=f"PE_{k}", kind="person", key=k, canonical_name=v["name"],
                    id_fragment=v["idfrag"], address=v["addr"])
               for k, v in S.PERSONS.items()]
    clusters = dict(
        entities=companies + persons,
        expectations=dict(
            same_name_persons_split=["P_WHF_A", "P_WHF_B", "P_WHF_C"],
            # P_WHF_D shares both name AND address with P_WHF_A but ID fragments differ
            same_name_and_address_but_distinct=["P_WHF_A", "P_WHF_D"],
            company_alias_groups={k: [v["name"], *v["former"]] for k, v in S.COMPANIES.items() if v["former"]},
            never_merge=[
                ["海峰投资有限公司", "蓝海科技有限公司"],
                ["蓝海科技有限公司", "蓝海贸易有限公司"],
                ["启明投资有限公司", "启明生物科技有限公司"],
                ["启明投资有限公司", "启明汇智科技有限公司"],
            ],
            noise_companies=[k for k in S.COMPANIES if k.startswith("NOISE") or k == "AMBIG"],
        ),
    )
    json.dump(clusters, open(os.path.join(OUT, "clusters.json"), "w"), ensure_ascii=False, indent=2)
    print("ground truth written to", OUT)


if __name__ == "__main__":
    main()
