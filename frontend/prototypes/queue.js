/* Direction: 队列. Fixture only. */
(function () {
	const P = window.Proto;
	const F = window.FIXTURE;
	const opened = { id: null };
	const initial = P.state();
	if (initial === "completed" || initial === "partial") opened.id = "c1";

	function step(state) {
		const now = state === "running" ? "寻源" : state === "completed" || state === "partial" || state === "failed" ? "结果" : "需求";
		return ["需求", "寻源", "结果"].map((name) => `<span class="${name === now ? "now" : ""}">${name}</span>`).join("");
	}

	function listStatus(state) {
		return { running: "进行中", completed: "已结束", partial: "部分完成", failed: "未能完成", input: "待寻源" }[state] || "";
	}

	function demand(state) {
		if (state === "input" || state === "running") {
			const locked = state === "running" ? "disabled" : "";
			return `<label><textarea aria-label="需求文字" ${locked}>${P.esc(F.demand)}</textarea></label>
				<div class="files"><button type="button" ${locked}>上传 PPTX</button><button type="button" ${locked}>上传历史 XLSX</button></div>
				<ul class="received"><li>文字需求已提交，修订 1</li><li class="file">${P.esc(F.pptx)} 已接收</li><li class="file">${P.esc(F.xlsx)} 已接收</li></ul>
				<p><button type="button" ${locked}>导入历史数据</button> <button class="solid" type="button" ${locked}>${state === "running" ? "寻源进行中" : "开始寻源"}</button></p>`;
		}
		if (state === "empty" || state === "denied") return `<p>创建或打开一个项目</p>`;
		return `<p class="quiet">需求 · 修订 1 · PPTX 已接收 · 历史文件已接收，1000 行</p>`;
	}

	function run(state) {
		if (!["running", "completed", "partial", "failed"].includes(state)) return "";
		const title = state === "running" ? "查阅公开资料" : state === "partial" ? "部分完成" : state === "failed" ? "未能完成" : "寻源已结束";
		const note = state === "partial" ? `<div class="abnormal" role="alert"><p>已保留目前得到的结果。本次公开查阅的次数已用完。</p></div>` : state === "failed" ? `<div class="abnormal failed" role="alert"><p>寻源没有完成。分析超时。</p></div>` : "";
		const report = state === "completed" ? `<p><a href="#report">下载这一版</a></p>` : state === "partial" || state === "failed" ? `<p class="quiet">报告还没有生成</p>` : "";
		return `<h2>${title}</h2><p class="meta">运行 ${P.esc(F.runId)}</p>${note}<details><summary>过程记录</summary><ol><li><time>10-31 09:12</time>读取需求</li><li><time>10-31 09:14</time>整理资料</li><li><time>10-31 09:16</time>查阅公开资料</li></ol></details>${report}`;
	}

	function results(state) {
		return P.rows(state).map((item) => {
			const open = opened.id === item.id;
			return `<article class="candidate ${open ? "open" : ""}"><button type="button" class="line" data-open="${P.esc(item.id)}"><span class="name">${P.esc(item.supplier)}</span><br><span class="sub">${P.esc(item.model)} · ${P.esc(item.stage)} · ${P.esc(item.tech)}</span></button>${open ? `<div class="band">${P.evidence(item)}</div>` : ""}</article>`;
		}).join("");
	}

	function render() {
		const state = P.state();
		const hasProject = state !== "empty" && state !== "denied";
		const projects = hasProject ? `<ul class="projects"><li><button type="button" class="current"><span>${P.esc(F.title)}</span> ${listStatus(state)}</button></li><li><button type="button"><span>园区门禁与车牌摄像机</span> 已结束</button></li></ul>` : "";
		const composer = hasProject ? "" : `<form class="switch"><input aria-label="项目名称"><button type="button">创建</button><input aria-label="项目编号"><button type="button" disabled>打开</button></form>`;
		const alert = state === "denied" ? `<div class="abnormal failed" role="alert"><p>访问被拒绝。</p></div>` : "";
		document.getElementById("top").innerHTML = `<p class="steps">${step(state)}</p>${composer}${projects}`;
		document.getElementById("work").innerHTML = `${hasProject ? `<h1>${P.esc(F.title)}</h1>` : ""}${demand(state)}${alert}${run(state)}${results(state)}`;
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
