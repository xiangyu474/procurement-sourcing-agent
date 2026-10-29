# Requirement DSL 速查

这份文档回答一个问题：**需求里的一个技术条件，怎么写成机器能比较的东西。**

读完能自己写出一条合法的约束，并能看出别人写的约束哪里不对。

它不解释需求怎么被抽出来（那是编译器的事），也不解释产品参数怎么跟需求比（那是 M3 的对齐与计算器的事）。

代码即契约：`src/procurement_agent/domain/requirements.py`。这份文档讲的是那份代码的用法。

## 一、一条约束长什么样

需求原话：**「采购 5MP 工业网络摄像机 10 套」**

```json
{
  "constraint_id": "pptx_1:c1",
  "requirement_id": "pptx_1:r1",
  "schema_version": "1.0",
  "attribute_key": "output_resolution",
  "attribute_definition": "视频输出像素数",
  "value_type": "NUMBER",
  "operator": "GTE",
  "value": "5",
  "unit": "MP",
  "qualifiers": {},
  "importance": "HARD",
  "origin": "PPT_EXPLICIT",
  "source_ref": "pptx:project=76d8e459:file=m2-test-requirement.pptx:slide=1:shape=0:paragraph=1",
  "source_quote": "5MP 工业网络摄像机",
  "parse_status": "RESOLVED",
  "revision": 1
}
```

四段意思分开看：

- **要什么**：`attribute_key` + `operator` + `value` + `unit` → 「输出分辨率 ≥ 5 MP」
- **算的是哪个东西**：`attribute_definition` → 「视频输出像素数」，不是传感器有效像素
- **有多硬**：`importance` → `HARD`
- **哪句话说的**：`source_ref` + `source_quote` → 能指回 PPTX 的具体位置和原话

## 二、字段速查

| 字段 | 类型 | 说明 |
|---|---|---|
| `constraint_id` | 字符串 | 约束的稳定 ID |
| `requirement_id` | 字符串 | 属于哪条需求 |
| `schema_version` | `"1.0"` | 数据迁移和复算用 |
| `attribute_key` | 蛇形标识符 | 正则 `[a-z][a-z0-9_]{0,63}`，动态，不是固定枚举 |
| `attribute_definition` | 文本 | **必须写清测量对象** |
| `value_type` | 枚举 | `NUMBER` / `BOOLEAN` / `STRING` / `SET` / `RANGE` |
| `operator` | 枚举 | 见下表，按类型白名单 |
| `value` | 见下表 | 数值是十进制字符串，不是数字 |
| `unit` | 字符串或 null | 没有单位就写 `null`，不要留空字符串 |
| `qualifiers` | 对象 | 影响比较口径的上下文，如 `{"stream": "main"}` |
| `importance` | 枚举 | `HARD` / `PREFERENCE` / `UNKNOWN` |
| `origin` | 枚举 | `USER_EXPLICIT` / `PPT_EXPLICIT` / `PROJECT_POLICY` / `INFERRED_FOR_REVIEW` |
| `source_ref` | 字符串 | 源坐标，如 `pptx:slide=6:table=1:row=3` |
| `source_quote` | 字符串 | 原文片段，必须逐字来自源 |
| `parse_status` | 枚举 | `RESOLVED` / `AMBIGUOUS` / `UNSUPPORTED` |
| `revision` | 整数 | 需求修订后递增，用于缓存失效 |

## 三、值类型与算子

算子按值类型白名单，**不执行任意表达式**：

| `value_type` | 允许的算子 | 例子 |
|---|---|---|
| `NUMBER` | `GTE` `LTE` `EQ` `NE` | 功率 ≥ 7.5 kW |
| `BOOLEAN` | `EQ` `NE` | 接入 OneNET = 是 |
| `STRING` | `EQ` `NE` `IN` | 接口型号在规定名单内 |
| `SET` | `CONTAINS` `IN` | 支持协议列表包含 ONVIF |
| `RANGE` | `RANGE_COVERS` | 工作温度 [-30,90] 覆盖 [-20,80] |

### 值怎么存

| 类型 | `value` 的存法 | 例 |
|---|---|---|
| `NUMBER` | 十进制字符串 | `"5"`、`"7.5"`、`"-20"` |
| `BOOLEAN` | JSON 布尔 | `true` |
| `STRING` | 文本；配 `IN` 时是文本数组 | `"RJ45"`、`["RJ45","M12"]` |
| `SET` | 去重后的字符串数组 | `["ONVIF"]` |
| `RANGE` | 对象，含 `lower`/`upper`/`lower_inclusive`/`upper_inclusive` | `{"lower":"-20","upper":"80","lower_inclusive":true,"upper_inclusive":true}` |

**数值必须是字符串**，因为浮点比较会出错。计算器内部用 `Decimal`。

## 四、三种状态，各管一件事

### `importance`：这条有多硬

- `HARD`：不满足就不能买。只有一条可靠的 HARD FAIL，整体就是 FAIL。
- `PREFERENCE`：尽量满足。不满足不否决型号，也不影响整体结论。
- `UNKNOWN`：不知道。默认档。

### `origin`：这句话是谁说的

- `USER_EXPLICIT` / `PPT_EXPLICIT`：原文里明写了
- `PROJECT_POLICY`：项目政策
- `INFERRED_FOR_REVIEW`：**模型推断的，只能是 `PREFERENCE` 或 `UNKNOWN`**。校验器会拒绝把它标成 `HARD`。

### `parse_status`：这条能不能自动判定

- `RESOLVED`：必须同时有 `source_ref` 和 `source_quote`，否则校验不过
- `AMBIGUOUS`：有歧义，比如「500 万像素」没说是传感器还是视频输出
- `UNSUPPORTED`：没法安全变成比较，比如「工业级可靠」

**只有 `RESOLVED` 的约束进入自动 PASS/FAIL。** 歧义的约束照样算进结果，但结论是 UNKNOWN。

## 五、常见的坑

**1. 品名里的规格不算约束。**
「5MP 工业网络摄像机」如果只把 5MP 留在 `product_name` 里，约束数组就是空的，M3 拿它跟任何产品都比不了。规格要单独写成一条带引文的约束。

**2. `attribute_definition` 不能省。**
`rated_output_power`（额定输出功率）和 `max_input_power`（最大输入功率）光看名字像同类，含义完全不同。要求 7.5 kW 额定输出功率，产品只写了 8 kW 最大输入功率——**不能判 PASS**，判 UNKNOWN。这条差别就写在 `attribute_definition` 里。

**3. 单位不同不等于能换算。**
150 μm 和 0.2 mm 可以比（同长度）。32 GB 和 32 GiB 不能比（十进制和二进制）。5 MP 和 5 px 能比（都是像素数）。换算表见 `src/procurement_agent/domain/units.py`。

**4. 一边有单位一边没有，不能比。**
需求写「不低于 5」，产品写「5 MP」——不知道需求的 5 是什么单位，判 UNKNOWN。

**5. 数值不等于数量或金额。**
`quantity` 和 `planned_unit_price` 是 `Requirement` 的顶层字段，不重复做成技术约束。

**6. `SET` 的值必须是数组。**
`CONTAINS` 拿到一个裸字符串时，计算器拒绝做无控制的子串匹配，判 UNKNOWN。

**7. `EQ` 不带误差容忍。**
需求说 220 V，产品说 220 V 才算 PASS。要按公差比较，就把公差写成结构化限定条件，不要指望比较函数自己放宽。

**8. 推断不能升格成硬约束。**
模型推断出来的阈值只能是 `PREFERENCE`，校验器直接拒绝 `INFERRED_FOR_REVIEW` + `HARD`。

## 六、M3 怎么用这份 DSL

需求侧和产品侧用**同一套**值类型和算子，中间只隔一层「对齐」：

```
RequirementConstraint  ──对齐──▶  ProductAttributeClaim  ──计算──▶  ConstraintCheck
（attribute_key/value_type/operator/value/unit）      （同结构，多了 evidence_ids）
```

对齐要回答的是：**这两个属性量的是同一个东西吗？** 判定由代码保守把关，对不齐就是 UNKNOWN，不是 PASS。

算完之后按 `importance` 聚合：

| 情况 | 整体结论 |
|---|---|
| 有一条可靠的 HARD FAIL | `FAIL`（其余 UNKNOWN 也照样 FAIL） |
| 所有 HARD 都 PASS，且没有未决需求 | `PASS` |
| 没有 HARD 约束 | `UNKNOWN`（不许说「技术符合」） |
| 其他情况 | `UNKNOWN` |

## 七、代码和测试在哪

| 内容 | 位置 |
|---|---|
| 契约本体 | `src/procurement_agent/domain/requirements.py` |
| 单位换算表 | `src/procurement_agent/domain/units.py` |
| 对齐与评估契约 | `src/procurement_agent/domain/spec_alignment.py` |
| 计算器 | `src/procurement_agent/services/spec_calculator.py` |
| DSL 契约测试 | `tests/test_requirement_dsl.py` |
| 计算器测试 | `tests/test_spec_calculator.py` |
| 逐字段说明 | `docs/data_model.md` |
| 设计理由与执行语义 | `前期需求分析/Procurement_Agent_Coding_Handoff_v1.3_DELTA/Sourcing_Agent_Requirement_DSL_Calculator_SPEC_v1.0.md` 第 4、5 节 |
