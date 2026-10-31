/* Direction: 对照. Fixture only. Final visual spec for sign-off. */
(function () {
	const P = window.Proto;
	const F = window.FIXTURE;
	const opened = { id: null };
	const initial = P.state();
	if (initial === "completed" || initial === "partial" || initial === "noreport") opened.id = "c1";

	const PRICE_ORDER = ["计划预算", "历史成交价", "公网参考价", "正式报价"];
	const RUN_WHEN = "10月31日 09:16";

	function listStatus(state) {
		if (state === "running") return ["进行中", "st-run"];
		if (state === "partial") return ["部分完成", "st-partial"];
		if (state === "failed") return ["未能完成", "st-fail"];
		if (state === "input") return ["待寻源", ""];
		if (state === "completed" || state === "noreport") return ["已结束", ""];
		return ["", ""];
	}

	function techClass(value) {
		if (value === "满足") return "tech pass";
		if (value === "不满足") return "tech fail";
		return "tech unknown";
	}

	function stageClass(value) {
		return value === "建议先询价" ? "stage short" : "stage long";
	}

	function nav() {
		return `<aside class="nav">
			<form class="create">
				<input aria-label="新项目名称" placeholder="新项目名称">
				<button type="button">创建</button>
			</form>
			<div class="project-list" id="projects"></div>
			<details class="by-id">
				<summary>用编号打开</summary>
				<form>
					<input aria-label="项目编号" placeholder="项目编号">
					<button type="button">打开</button>
				</form>
			</details>
		</aside>`;
	}

	function projects(state) {
		if (state === "empty" || state === "denied") return "";
		const [label, tone] = listStatus(state);
		return `<button type="button" class="project current"><span>${P.esc(F.title)}</span><span class="${tone}">${label}</span></button>
			<button type="button" class="project"><span>园区门禁与车牌摄像机</span><span>已结束</span></button>`;
	}

	function demand(state) {
		if (state === "input" || state === "running") {
			const locked = state === "running" ? "disabled" : "";
			return `<label class="field"><textarea aria-label="需求文字" placeholder="填写采购需求" ${locked}>${P.esc(F.demand)}</textarea></label>
				<div class="files"><button type="button" ${locked}>上传 PPTX</button><button type="button" ${locked}>上传历史 XLSX</button></div>
				<ul class="received"><li>文字需求已提交，修订 1</li><li>${P.esc(F.pptx)} 已接收</li><li>${P.esc(F.xlsx)} 已接收</li></ul>
				<div class="actions"><button class="ghost" type="button" ${locked}>导入历史数据</button><button class="primary" type="button" ${locked}>${state === "running" ? "寻源进行中" : "开始寻源"}</button></div>`;
		}
		if (state === "empty" || state === "denied") return "";
		return `<details class="summary"><summary>需求 · 修订 1 · PPTX 已接收 · 历史文件已接收，1000 行</summary><p>${P.esc(F.demand)}</p></details>`;
	}

	function reportControl(state) {
		if (state === "completed") return `<div class="report"><button class="download" type="button">下载这一版</button></div>`;
		if (state === "noreport" || state === "partial") return `<div class="report"><button class="download" type="button" disabled>下载这一版</button><span class="quiet">报告还没有生成</span></div>`;
		return "";
	}

	function run(state) {
		if (state === "input" || state === "empty" || state === "denied") return "";
		const title = state === "running" ? "正在查阅公开资料" : state === "partial" ? "部分完成" : state === "failed" ? "未能完成" : "寻源已结束";
		const tone = state === "running" ? "tone-running" : state === "partial" ? "tone-partial" : state === "failed" ? "tone-fail" : "";
		const when = state === "running" ? `${RUN_WHEN} 开始` : `${RUN_WHEN} 的寻源`;
		const note = state === "partial" ? `<div class="abnormal" role="alert"><p>已保留目前得到的结果。本次公开查阅的次数已用完。</p></div>` : state === "failed" ? `<div class="abnormal failed" role="alert"><p>寻源没有完成。分析超时。</p></div>` : "";
		return `<h2 class="status ${tone}">${title}</h2><p class="version">${when}</p>${note}
			<details class="trace"><summary>过程记录</summary><ol><li><time>09:12</time> 读取需求</li><li><time>09:14</time> 整理资料</li><li><time>09:16</time> 查阅公开资料</li><li class="id">编号 ${P.esc(F.runId)}</li></ol></details>`;
	}

	function prices(item) {
		if (!item.evidence) return "";
		const byKind = new Map(item.prices.map((price) => [price.kind, price.text]));
		const rows = PRICE_ORDER.map((kind) => `<div><dt>${kind}</dt><dd>${P.esc(byKind.get(kind) || "还没有")}</dd></div>`).join("");
		return `<h3>价格</h3><dl class="prices">${rows}</dl>`;
	}

	function detail(item) {
		if (!item) return `<aside class="detail"><p class="quiet">选择一行查看来源。</p></aside>`;
		const source = item.evidence ? `<h3>来源</h3><p>${P.esc(item.evidence.title)} · ${P.esc(item.evidence.retrieved)}</p><h3>摘录</h3><blockquote>${P.esc(item.evidence.excerpt)}</blockquote>` : "";
		const gap = item.gap ? `<p>${P.esc(item.gap)}</p>` : "";
		return `<aside class="detail linked" aria-label="所选型号"><h2>${P.esc(item.model)}</h2><p class="who">${P.esc(item.supplier)}</p><p><span class="${stageClass(item.stage)}">${P.esc(item.stage)}</span> · <span class="${techClass(item.tech)}">${P.esc(item.tech)}</span></p><p class="quiet">${P.esc(item.stageNote)}</p>${gap}${source}${prices(item)}</aside>`;
	}

	function table(state) {
		const items = P.rows(state);
		if (!items.length) return "";
		const selected = items.find((item) => item.id === opened.id) || null;
		const body = items.map((item) => {
			const on = item.id === opened.id ? "selected" : "";
			return `<tr class="${on}" data-open="${P.esc(item.id)}" aria-selected="${on ? "true" : "false"}"><td data-label="供应商"><span class="supplier">${P.esc(item.supplier)}</span></td><td data-label="型号"><span class="model">${P.esc(item.model)}</span></td><td data-label="阶段"><span class="${stageClass(item.stage)}">${P.esc(item.stage)}</span></td><td data-label="技术"><span class="${techClass(item.tech)}">${P.esc(item.tech)}</span></td></tr>`;
		}).join("");
		return `<div class="split"><table><colgroup><col class="supplier"><col class="model"><col class="stage"><col class="tech"></colgroup><thead><tr><th>供应商</th><th>型号</th><th>阶段</th><th>技术</th></tr></thead><tbody>${body}</tbody></table>${detail(selected)}</div>`;
	}

	function render() {
		const state = P.state();
		const alert = state === "denied" ? `<div class="abnormal failed" role="alert"><p>访问被拒绝。</p></div>` : "";
		const hasProject = state !== "empty" && state !== "denied";
		const work = hasProject ? `<div class="head"><h1>${P.esc(F.title)}</h1>${reportControl(state)}</div>${demand(state)}${run(state)}${table(state)}` : alert;
		document.getElementById("app").innerHTML = `${nav()}<main class="work">${work}</main>`;
		document.getElementById("projects").innerHTML = projects(state);
		P.mark();
	}

	document.addEventListener("click", (event) => {
		const row = event.target.closest("tr[data-open]");
		if (!row || !document.getElementById("app").contains(row)) return;
		opened.id = opened.id === row.dataset.open ? null : row.dataset.open;
		render();
	});
	render();
})();
