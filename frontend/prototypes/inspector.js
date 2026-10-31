/* Direction: 对照. Fixture only. */
(function () {
	const P = window.Proto;
	const F = window.FIXTURE;
	const opened = { id: null };
	const initial = P.state();
	if (initial === "completed" || initial === "partial") opened.id = "c1";

	function listStatus(state) {
		return { running: "进行中", completed: "已结束", partial: "部分完成", failed: "未能完成", input: "待寻源" }[state] || "";
	}

	function demand(state) {
		if (state === "input" || state === "running") {
			const locked = state === "running" ? "disabled" : "";
			return `<label><textarea aria-label="需求文字" ${locked}>${P.esc(F.demand)}</textarea></label>
				<div class="files"><button type="button" ${locked}>上传 PPTX</button><button type="button" ${locked}>上传历史 XLSX</button></div>
				<ul class="received"><li>文字需求已提交，修订 1</li><li class="file">${P.esc(F.pptx)} 已接收</li><li class="file">${P.esc(F.xlsx)} 已接收</li></ul>
				<p><button type="button" ${locked}>导入历史数据</button> <button class="primary" type="button" ${locked}>${state === "running" ? "寻源进行中" : "开始寻源"}</button></p>`;
		}
		if (state === "empty" || state === "denied") return "";
		return `<p class="summary-line">需求 · 修订 1 · PPTX 已接收 · 历史文件已接收，1000 行</p>`;
	}

	function run(state) {
		if (state === "input" || state === "empty" || state === "denied") return "";
		const title = state === "running" ? "查阅公开资料" : state === "partial" ? "部分完成" : state === "failed" ? "未能完成" : "寻源已结束";
		const note = state === "partial" ? `<div class="abnormal" role="alert"><p>已保留目前得到的结果。本次公开查阅的次数已用完。</p></div>` : state === "failed" ? `<div class="abnormal failed" role="alert"><p>寻源没有完成。分析超时。</p></div>` : "";
		return `<h2 class="run">${title}</h2><p class="meta">运行 ${P.esc(F.runId)}</p>${note}<details><summary>过程记录</summary><ol><li><time>10-31 09:12</time>读取需求</li><li><time>10-31 09:14</time>整理资料</li><li><time>10-31 09:16</time>查阅公开资料</li></ol></details>`;
	}

	function table(state) {
		const items = P.rows(state);
		if (!items.length) return "";
		const selected = items.find((item) => item.id === opened.id) || null;
		const body = items.map((item) => `<tr class="${item.id === opened.id ? "selected" : ""}"><td data-label="供应商"><button type="button" class="rowhit" data-open="${P.esc(item.id)}"><span class="supplier">${P.esc(item.supplier)}</span></button></td><td data-label="型号">${P.esc(item.model)}</td><td data-label="阶段">${P.esc(item.stage)}</td><td data-label="技术">${P.esc(item.tech)}</td></tr>`).join("");
		const detail = selected ? `<aside class="detail"><h2>${P.esc(selected.model)}</h2>${P.evidence(selected)}</aside>` : `<aside class="detail"><p class="quiet">选择一行查看来源。</p></aside>`;
		return `<div class="split"><table><thead><tr><th>供应商</th><th>型号</th><th>阶段</th><th>技术</th></tr></thead><tbody>${body}</tbody></table>${detail}</div>`;
	}

	function render() {
		const state = P.state();
		const hasProject = state !== "empty" && state !== "denied";
		const nav = `<aside class="nav"><form class="create"><input aria-label="项目名称"><button type="button">创建</button></form>
			<div class="project-list">${hasProject ? `<button type="button" class="project current"><span>${P.esc(F.title)}</span><span>${listStatus(state)}</span></button><button type="button" class="project"><span>园区门禁与车牌摄像机</span><span>已结束</span></button>` : ""}</div>
			<form class="open"><input aria-label="项目编号"><button type="button" disabled>打开</button></form></aside>`;
		const report = state === "completed" ? `<a href="#report">下载这一版</a>` : state === "partial" || state === "failed" ? `<span class="quiet">报告还没有生成</span>` : "";
		const alert = state === "denied" ? `<div class="abnormal failed" role="alert"><p>访问被拒绝。</p></div>` : "";
		const work = hasProject ? `<div class="head"><h1>${P.esc(F.title)}</h1>${report}</div>${demand(state)}${run(state)}${table(state)}` : `<p>创建或打开一个项目</p>${alert}`;
		document.getElementById("app").innerHTML = `${nav}<main class="work">${work}</main>`;
		P.mark();
	}

	document.addEventListener("click", (event) => {
		const button = event.target.closest("[data-open]");
		if (!button) return;
		opened.id = opened.id === button.dataset.open ? null : button.dataset.open;
		render();
	});
	render();
})();
