/* Direction: 备忘录. Fixture only. */
(function () {
	const P = window.Proto;
	const F = window.FIXTURE;
	const opened = { id: null };
	const initial = P.state();
	if (initial === "completed" || initial === "partial") opened.id = "c1";

	function listStatus(state) {
		if (state === "running") return "进行中";
		if (state === "completed") return "已结束";
		if (state === "partial") return "部分完成";
		if (state === "failed") return "未能完成";
		if (state === "input") return "待寻源";
		return "";
	}

	function demand(state) {
		if (state === "input" || state === "running") {
			const locked = state === "running" ? "disabled" : "";
			return `<label class="field"><textarea aria-label="需求文字" ${locked}>${P.esc(F.demand)}</textarea></label>
				<div class="files"><button type="button" ${locked}>上传 PPTX</button><button type="button" ${locked}>上传历史 XLSX</button></div>
				<ul class="received"><li>文字需求已提交，修订 1</li><li class="file">${P.esc(F.pptx)} 已接收</li><li class="file">${P.esc(F.xlsx)} 已接收</li></ul>
				<button type="button" ${locked}>导入历史数据</button>
				<div class="actions"><button class="ink" type="button" ${locked}>${state === "running" ? "寻源进行中" : "开始寻源"}</button></div>`;
		}
		if (state === "empty" || state === "denied") return "";
		return `<p>需求 · 修订 1 · PPTX 已接收 · 历史文件已接收，1000 行</p>`;
	}

	function run(state) {
		if (state === "input" || state === "empty" || state === "denied") return "";
		const title = state === "running" ? "查阅公开资料" : state === "partial" ? "部分完成" : state === "failed" ? "未能完成" : "寻源已结束";
		const note = state === "partial" ? `<div class="abnormal" role="alert"><p>已保留目前得到的结果。本次公开查阅的次数已用完。</p></div>` : state === "failed" ? `<div class="abnormal failed" role="alert"><p>寻源没有完成。分析超时。</p></div>` : "";
		const report = state === "completed" ? `<p class="download"><a href="#report">下载这一版</a></p>` : state === "partial" || state === "failed" ? `<p class="quiet">报告还没有生成</p>` : "";
		return `<hr class="rule"><section><h2>${title}</h2><p class="meta">运行 ${P.esc(F.runId)}</p>${note}
			<details><summary>过程记录</summary><ol><li><time>10-31 09:12</time>读取需求</li><li><time>10-31 09:14</time>整理资料</li><li><time>10-31 09:16</time>查阅公开资料</li></ol></details>${report}</section>`;
	}

	function results(state) {
		const items = P.rows(state);
		if (!items.length) return "";
		const body = items.map((item) => {
			const open = opened.id === item.id;
			return `<article class="row ${open ? "open" : ""}"><button type="button" class="row-btn" data-open="${P.esc(item.id)}"><span class="name">${P.esc(item.supplier)}</span><span>${P.esc(item.model)}</span><span>${P.esc(item.stage)}</span><span>${P.esc(item.tech)}</span></button>${open ? P.evidence(item) : ""}</article>`;
		}).join("");
		return `<hr class="rule"><section><h2>候选</h2>${body}</section>`;
	}

	function render() {
		const state = P.state();
		const hasProject = state !== "empty" && state !== "denied";
		const index = `<aside class="index"><form class="create"><input aria-label="项目名称"><button type="button">创建</button></form>
			<div class="project-list">${hasProject ? `<button type="button" class="project current"><span>${P.esc(F.title)}</span><span>${listStatus(state)}</span></button><button type="button" class="project"><span>园区门禁与车牌摄像机</span><span>已结束</span></button>` : ""}</div>
			<form class="open"><input aria-label="项目编号"><button type="button" disabled>打开</button></form></aside>`;
		const alert = state === "denied" ? `<div class="abnormal failed" role="alert"><p>访问被拒绝。</p></div>` : "";
		const main = hasProject ? `<h1>${P.esc(F.title)}</h1>${demand(state)}${run(state)}${results(state)}` : `<p>创建或打开一个项目</p>${alert}`;
		document.getElementById("app").innerHTML = `${index}<main class="memo">${main}</main>`;
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
