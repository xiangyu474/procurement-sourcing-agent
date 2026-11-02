import { useState } from "react";
import type { EvidenceDetail } from "../api/types";
import type { CandidateRowView } from "../view/candidates";

export function EvidencePane(props: {
	row: CandidateRowView | null;
	evidence: EvidenceDetail | null;
	evidenceError: string | null;
	onOpenEvidence: (evidenceId: string) => void;
}) {
	const [showBasis, setShowBasis] = useState(false);
	const row = props.row;
	if (!row) {
		return (
			<aside className="detail" aria-label="所选型号">
				<p className="quiet">选择一行查看来源。</p>
			</aside>
		);
	}
	const source = [row.sourceTitle, row.sourceDate].filter(Boolean).join(" · ");
	return (
		<aside className="detail linked" aria-label="所选型号">
			<h2>{row.model}</h2>
			<p className="who">{row.supplier}</p>
			<p>
				<span className={row.stage.tone === "short" ? "stage short" : row.stage.tone === "verify" ? "stage verify" : "stage long"}>{row.stage.label}</span>
				{" · "}
				<span className={row.technical.tone === "pass" ? "tech pass" : row.technical.tone === "fail" ? "tech fail" : row.technical.tone === "unknown" ? "tech unknown" : "tech none"}>
					{row.technical.label}
				</span>
			</p>
			<p className="quiet">{row.stage.note}</p>
			{row.ambiguous ? <p className="quiet">同一候选有多条核对，这里显示最近一条。</p> : null}
			{source ? (
				<>
					<h3>来源</h3>
					<p>{source}</p>
				</>
			) : (
				<p className="quiet">还没有来源。</p>
			)}
			{row.excerpt ? (
				<>
					<h3>摘录</h3>
					<blockquote>{row.excerpt}</blockquote>
				</>
			) : null}
			{row.evidenceId ? (
				<p>
					<button className="text-button" type="button" onClick={() => props.onOpenEvidence(row.evidenceId!)}>
						查看这条来源
					</button>
					{row.sourceUrl ? (
						<>
							{" "}
							<a href={row.sourceUrl} target="_blank" rel="noreferrer">
								打开来源页面
							</a>
						</>
					) : null}
				</p>
			) : null}
			{props.evidenceError ? <p className="quiet">{props.evidenceError}</p> : null}
			{props.evidence && props.evidence.evidence_id === row.evidenceId && props.evidence.snapshot_text ? (
				<blockquote className="snapshot">{props.evidence.snapshot_text}</blockquote>
			) : null}
			<h3>判断</h3>
			{row.checks.length === 0 ? <p className="quiet">还没有逐条判断。</p> : null}
			<ul className="checks">
				{row.checks.map((check, index) => (
					<li key={`${check.requirement}-${index}`}>
						<p>
							{check.requirement}
							{" · "}
							<span className={check.result.tone === "pass" ? "tech pass" : check.result.tone === "fail" ? "tech fail" : "tech unknown"}>{check.result.label}</span>
						</p>
						<p>{check.observed}</p>
						{check.reason ? <p>{check.reason}</p> : null}
					</li>
				))}
			</ul>
			{row.checks.some((check) => check.formula || check.reasonCode || check.evidenceIds.length > 0) ? (
				<p>
					<button className="text-button" type="button" onClick={() => setShowBasis((value) => !value)}>
						{showBasis ? "收起计算和依据" : "计算和依据"}
					</button>
				</p>
			) : null}
			{showBasis ? (
				<ul className="basis">
					{row.checks.map((check, index) => (
						<li key={`basis-${index}`}>
							{check.formula ? <p>计算：{check.formula}</p> : null}
							{check.reasonCode ? <p>原因码：{check.reasonCode}</p> : null}
							{check.evidenceIds.length > 0 ? <p>证据编号：{check.evidenceIds.join("、")}</p> : null}
						</li>
					))}
				</ul>
			) : null}
			{row.rationale ? <p>{row.rationale}</p> : null}
			<h3>价格</h3>
			<dl className="prices">
				{row.prices.map((price) => (
					<div key={price.label}>
						<dt>{price.label}</dt>
						<dd>{price.text}</dd>
					</div>
				))}
			</dl>
		</aside>
	);
}
