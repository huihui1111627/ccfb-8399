"""Scenario authoring for the equity-piercing demo (test-data tooling only).

Single source of truth for generating the deliberately messy raw registration
files and for the independently stored ground truth. The TypeScript application
never imports this module; it only sees the generated raw CSVs.
"""

COMPANIES = {
    "BLUE": dict(name="蓝海科技有限公司", uscc="91440300MA5F0001XA", short="蓝海科技",
                 former=["蓝海网络技术有限公司"], addr="深圳市南山区科技园南区A栋18层",
                 legal="P_WHF_A", established="2011-03-18", capital=5000),
    "STAR": dict(name="星海控股有限公司", uscc="91440300MA5F0002XB", short="星海控股",
                 former=["星海投资管理有限公司"], addr="深圳市福田区金田路3088号",
                 legal="P_WHF_A", established="2010-06-09", capital=10000),
    "PC": dict(name="鹏程实业有限公司", uscc="91440300MA5F0003XC", short="鹏程实业",
               former=[], addr="深圳市罗湖区人民南路2008号",
               legal="P_CZY", established="2012-01-11", capital=3000),
    "ZY": dict(name="中原控股有限公司", uscc="91410100MA3X0004XD", short="中原控股",
               former=[], addr="郑州市金水区商务外环路10号",
               legal="P_LIN", established="2009-08-21", capital=8000),
    "QM": dict(name="启明投资有限公司", uscc="91310115MA1K0005XE", short="启明投资",
               former=["启明创业投资有限公司"], addr="上海市浦东新区世纪大道100号",
               legal="P_CZY", established="2010-11-02", capital=6000),
    "QH": dict(name="启明汇智科技有限公司", uscc="91310115MA1K0006XF", short="启明汇智",
               former=[], addr="上海市浦东新区张江路88号",
               legal="P_LIN", established="2015-04-27", capital=2000),
    "HC": dict(name="华创科技有限公司", uscc="91440300MA5F0007XG", short="华创科技",
               former=[], addr="深圳市南山区高新南一道9号",
               legal="P_CZY", established="2013-07-15", capital=4000),
    "ZHI": dict(name="智源智能装备有限公司", uscc="91442000MA4W0008XH", short="智源智能",
                former=[], addr="中山市火炬开发区兴业路6号",
                legal="P_CZY", established="2016-02-03", capital=1500),
    "HENG": dict(name="恒昌贸易有限公司", uscc="91440300MA5F0009XI", short="恒昌贸易",
                 former=[], addr="深圳市宝安区新安街道海秀路",
                 legal="P_LIN", established="2014-09-12", capital=800),
    "ZK": dict(name="中科数据服务有限公司", uscc="91110108MA010010XJ", short="中科数据",
               former=[], addr="北京市海淀区中关村大街18号",
               legal="P_SUN", established="2012-05-30", capital=2500),
    "HK": dict(name="中科数据（香港）有限公司", uscc="HK-90010011XK", short="中科香港",
               former=[], addr="香港中环皇后大道中99号",
               legal="P_MA", established="2015-10-08", capital=1000),
    "BLUEDEV": dict(name="蓝海智造设备有限公司", uscc="91440300MA5F0012XL", short="蓝海智造",
                    former=[], addr="上海市浦东新区川沙路200号",
                    legal="P_WHF_C", established="2017-06-19", capital=1200),
    "XING": dict(name="星海资本管理有限公司", uscc="91440300MA5F0013XM", short="星海资本",
                 former=[], addr="深圳市福田区金田路3088号",
                 legal="P_WHF_A", established="2015-12-01", capital=2000),
    "COOP": dict(name="蓝海同创企业管理合伙企业（有限合伙）", uscc="91440300MA5F0014XN", short="蓝海同创",
                 former=[], addr="深圳市南山区科技园南区A栋18层",
                 legal="P_WHF_B", established="2018-03-06", capital=500),
    "YUANWANG": dict(name="元望咨询有限公司", uscc="91110105MA010015XP", short="元望咨询",
                     former=[], addr="北京市朝阳区建国路88号",
                     legal="P_LGD", established="2016-01-21", capital=300),
    "NOISE1": dict(name="蓝海贸易有限公司", uscc="91440300MA5F0016XQ", short="蓝海贸易",
                   former=[], addr="深圳市龙岗区布吉街道吉华路",
                   legal="P_WHF_B", established="2013-01-08", capital=600),
    "NOISE2": dict(name="星海传媒有限公司", uscc="91440300MA5F0017XR", short="星海传媒",
                   former=[], addr="深圳市南山区海德三道199号",
                   legal="P_ZHOU", established="2014-04-14", capital=700),
    "NOISE3": dict(name="启明生物科技有限公司", uscc="91310115MA1K0018XS", short="启明生物",
                   former=[], addr="上海市浦东新区张江路100号",
                   legal="P_WUJ", established="2016-08-30", capital=900),
    "AMBIG": dict(name="海峰投资有限公司", uscc="91440300MA5F0019XT", short="海峰投资",
                  former=[], addr="深圳市南山区粤海街道海德三道199号",
                  legal="P_WHF_B", established="2011-11-23", capital=2000),
    "NOISE4": dict(name="海峰资本管理有限公司", uscc="91440300MA5F0020XU", short="海峰资本",
                   former=[], addr="北京市朝阳区建国路88号",
                   legal="P_WHF_D", established="2018-07-02", capital=1000),
}

PERSONS = {
    "P_WHF_A": dict(name="王海峰", idfrag="110101********1234", addr="北京市朝阳区建国路88号"),
    "P_WHF_B": dict(name="王海峰", idfrag="440301********5678", addr="深圳市福田区香蜜湖路1号"),
    "P_WHF_C": dict(name="王海峰", idfrag="310104********9012", addr="上海市浦东新区川沙路300号"),
    "P_WHF_D": dict(name="王海峰", idfrag="110101********1239", addr="北京市朝阳区建国路88号"),
    "P_CZY": dict(name="陈志远", idfrag="310110********3456", addr="上海市浦东新区世纪大道100号"),
    "P_LGD": dict(name="李国栋", idfrag="440305********7890", addr="深圳市南山区高新南一道9号"),
    "P_ZHAO": dict(name="赵明", idfrag="330106********2233", addr="杭州市西湖区文三路90号"),
    "P_LIN": dict(name="林晓", idfrag="330106********4321", addr="杭州市西湖区文三路90号"),
    "P_ZHOU": dict(name="周敏", idfrag="440304********8765", addr="深圳市南山区海德三道199号"),
    "P_SUN": dict(name="孙强", idfrag="110108********6543", addr="北京市海淀区中关村大街18号"),
    "P_WUJ": dict(name="吴静", idfrag="310115********1122", addr="上海市浦东新区张江路100号"),
    "P_ZHENG": dict(name="郑凯", idfrag="440106********3344", addr="广州市天河区体育西路103号"),
    "P_MA": dict(name="马骏", idfrag="A123456(7)", addr="香港中环皇后大道中99号"),
    "P_FENG": dict(name="冯磊", idfrag="110105********8877", addr="北京市朝阳区建国路93号"),
}

S0 = "2019-01-01"
S1 = "2022-06-30"
S2 = "2025-12-31"
SNAPSHOT_DATES = [("S0", S0), ("S1", S1), ("S2", S2)]

# Full cap table timeline per company: (effective date, {holder: pct}). Each table
# must sum to exactly 1. Changes are replacement tables, mirroring 工商变更 batches.
TIMELINE = {
    "BLUE": [
        ("2019-01-01", {"P_WHF_A": .60, "ZY": .40}),
        ("2020-03-15", {"P_WHF_A": .45, "ZY": .30, "STAR": .25}),
        ("2022-05-01", {"STAR": .40, "QH": .20, "P_WHF_A": .15, "P_CZY": .10, "P_LIN": .10, "P_LGD": .05}),
    ],
    "STAR": [
        ("2019-01-01", {"P_WHF_A": .55, "P_CZY": .45}),
        ("2020-07-01", {"P_WHF_A": .40, "P_CZY": .45, "BLUE": .15}),
    ],
    "PC": [
        ("2019-01-01", {"P_CZY": .70, "P_ZHAO": .30}),
        ("2021-04-20", {"P_CZY": .55, "P_ZHAO": .25, "STAR": .20}),
        ("2025-01-10", {"P_CZY": .55, "P_ZHAO": .15, "P_WHF_B": .10, "STAR": .20}),
    ],
    "ZY": [
        ("2019-01-01", {"P_WHF_A": .35, "P_CZY": .25, "P_LGD": .15, "P_LIN": .25}),
        ("2022-02-01", {"P_WHF_A": .25, "P_CZY": .15, "P_LGD": .10, "P_LIN": .20, "QM": .30}),
    ],
    "QM": [
        ("2019-01-01", {"P_WHF_A": .30, "P_CZY": .40, "P_LIN": .30}),
        ("2022-02-01", {"P_WHF_A": .15, "P_CZY": .25, "P_LIN": .20, "ZY": .25, "QH": .15}),
    ],
    "QH": [
        ("2019-01-01", {"P_WHF_A": .30, "P_CZY": .20, "P_LIN": .50}),
        ("2022-02-01", {"P_WHF_A": .25, "P_CZY": .25, "P_LIN": .30, "QM": .20}),
    ],
    "HC": [
        ("2019-01-01", {"P_CZY": .40, "ZY": .60}),
        ("2021-09-10", {"ZY": .30, "QM": .20, "HK": .15, "P_CZY": .20, "P_WHF_A": .10, "P_LGD": .05}),
    ],
    "ZHI": [
        ("2019-01-01", {"P_CZY": .20, "HC": .80}),
        ("2024-08-01", {"HC": .55, "P_CZY": .30, "P_ZHENG": .15}),
    ],
    "HENG": [
        ("2019-01-01", {"P_LIN": .40, "PC": .60}),
        ("2024-08-01", {"PC": .40, "HC": .20, "P_LIN": .20, "P_LGD": .10, "P_ZHENG": .10}),
    ],
    "ZK": [
        ("2019-01-01", {"P_SUN": .50, "P_WUJ": .50}),
        ("2023-03-01", {"P_SUN": .40, "P_WUJ": .25, "P_ZHENG": .20, "P_MA": .15}),
    ],
    "HK": [
        ("2019-01-01", {"P_MA": .20, "ZK": .80}),
        ("2023-03-01", {"P_MA": .40, "ZK": .60}),
    ],
    "BLUEDEV": [
        ("2019-01-01", {"P_WHF_C": .80, "P_SUN": .20}),
        ("2025-03-01", {"P_WHF_C": .60, "P_SUN": .40}),
    ],
    "XING": [
        ("2019-01-01", {"P_WHF_A": .70, "P_ZHOU": .30}),
        ("2024-05-01", {"P_WHF_A": .55, "P_ZHOU": .40, "P_WHF_B": .05}),
    ],
    "COOP": [
        ("2019-01-01", {"P_WHF_A": .60, "P_WHF_B": .40}),
        ("2025-01-10", {"P_WHF_A": .55, "P_WHF_B": .45}),
    ],
    "YUANWANG": [
        ("2019-01-01", {"P_LGD": .20, "P_ZHAO": .20, "P_LIN": .20, "P_ZHOU": .20, "P_SUN": .20}),
    ],
    "NOISE1": [
        ("2019-01-01", {"P_WHF_B": .60, "P_ZHOU": .40}),
    ],
    "NOISE2": [
        ("2019-01-01", {"P_ZHOU": .60, "P_WUJ": .40}),
        ("2025-01-10", {"P_ZHOU": .60, "P_WUJ": .35, "P_WHF_D": .05}),
    ],
    "NOISE3": [
        ("2019-01-01", {"P_WUJ": .70, "P_ZHENG": .30}),
    ],
    "AMBIG": [
        ("2019-01-01", {"P_WHF_B": 1.0}),
    ],
    "NOISE4": [
        ("2019-01-01", {"P_WHF_D": .30, "P_FENG": .70}),
    ],
}

# Manual relationship facts (entered / confirmed by humans in the console).
RELATIONS = [
    dict(id="R1", type="concert", scope="QH", leader="P_CZY", members=["P_CZY", "P_WHF_A"],
         start="2022-02-01", end=None, note="启明汇智股东一致行动协议（陈志远牵头）"),
    dict(id="R2", type="concert", scope="ZY", leader="P_WHF_A", members=["P_WHF_A", "P_LIN"],
         start="2022-06-01", end=None, note="中原控股股东一致行动协议"),
    dict(id="R3", type="concert", scope="QM", leader="P_CZY", members=["P_CZY", "P_WHF_A"],
         start="2023-01-01", end=None, note="启明投资股东一致行动协议"),
    dict(id="R4", type="nominee", scope="BLUEDEV", leader=None, members=["P_WHF_A"],
         nominal="P_WHF_C", actual="P_WHF_A", start="2022-03-01", end=None,
         note="王海峰(310104********9012)代王海峰(110101********1234)持有蓝海智造60%股权"),
    dict(id="R5", type="nominee", scope="XING", leader=None, members=["P_WHF_B"],
         nominal="P_ZHOU", actual="P_WHF_B", start="2024-05-01", end=None,
         note="周敏代王海峰(440301********5678)持有星海资本5%股权"),
]

# Non-equity registration changes (name / address / legal rep) for history & aliases.
NON_EQUITY_CHANGES = [
    ("2012-05-06", "BLUE", "名称变更", "蓝海网络技术有限公司", "蓝海科技有限公司"),
    ("2014-08-19", "STAR", "名称变更", "星海投资管理有限公司", "星海控股有限公司"),
    ("2016-09-02", "QM", "名称变更", "启明创业投资有限公司", "启明投资有限公司"),
    ("2021-01-08", "XING", "法定代表人变更", "王海峰", "王海峰"),
    ("2021-01-08", "XING", "注册地址变更", "深圳市福田区益田路6003号", "深圳市福田区金田路3088号"),
    ("2023-06-12", "HENG", "注册地址变更", "深圳市宝安区宝源路2001号", "深圳市宝安区新安街道海秀路"),
]
