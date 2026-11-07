import { useEffect, useState } from "react";
import type { EvidenceDetail } from "../api/types";
import type { CandidateRowView, CheckView } from "../view/candidates";
import { untranslatedNote } from "../view/analysis";

function toneClass(tone: string, kind: "stage" | "tech"): string {
	if (kind === "tech") {
		if (tone === "pass") return "tech pass";
		if (tone === "fail") return "tech fail";
		if (tone === "unknown") return "tech unknown";
		return "tech none";
	}
	if (tone === "short") return "stage short";
	if (tone === "verify") return "stage verify";
	return "stage long";
}

function EvidenceBody(props: {
	row: CandidateRowView;
	evidence: EvidenceDetail | null;
	evidenceError: string | null;
	onOpenEvidence: (evidenceId: string) => void;
	onSelect: (id: string) => void;
	onClose: () => void;
}) {
	const [showBasis, setShowBasis] = useState(false);
	const row = props.row;
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			const target = event.target;
			if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
			props.onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [props.onClose]);
	const source = [row.sourceTitle].filter(Boolean).join(" · ");
	const pending = untranslatedNote(row.decision);
	return (
		<aside className="detail linked" aria-label="所选型号">
			<div className="detail-head">
				<h2>{row.model}</h2>
				<button className="close-detail" type="button" aria-label="关闭" onClick={props.onClose}>
					×
				</button>
			</div>
			<p className="who">{row.supplier}</p>
			<p>
				<span className={toneClass(row.stage.tone, "stage")}>{row.stage.label}</span>
				{" · "}
				<span className={toneClass(row.technical.tone, "tech")}>{row.technical.label}</span>
			</p>
			<p className="quiet">{row.stage.note}</p>
			{row.summary ? <p>{row.summary}</p> : null}
			{row.decision && row.decision.gaps.length > 0 ? (
				<>
					<h3>还差什么</h3>
					<ul className="checks">
						{row.decision.gaps.map((gap, index) => (
							<li key={`gap-${index}`}>
								<p>{gap.text}</p>
							</li>
						))}
					</ul>
				</>
			) : null}
			{row.decision && row.decision.nextActions.length > 0 ? (
				<>
					<h3>下一步</h3>
					<ul className="checks">
						{row.decision.nextActions.map((action, index) => (
							<li key={`action-${index}`}>
								<p>{action.text}</p>
							</li>
						))}
					</ul>
				</>
			) : null}
			{pending ? <p className="quiet">{pending}</p> : null}
			{row.ambiguous ? <p className="quiet">同一候选有多条核对，这里显示最近一条。</p> : null}
			{row.members.length > 1 ? (
				<>
					<h3>供应来源</h3>
					<ul className="received">
						{row.members.map((member) => (
							<li key={member.id}>
								<button className="text-button" type="button" onClick={() => props.onSelect(member.id)}>
									{member.supplier}
								</button>
							</li>
						))}
					</ul>
				</>
			) : null}
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
			{row.checks.length > 0 ? (
				<>
					<h3>判断</h3>
					<ul className="checks">
						{row.checks.map((check, index) => (
							<li key={`${check.requirement}-${index}`}>
								<p>
									{check.requirement}
									{" · "}
									<span className={toneClass(check.result.tone, "tech")}>{check.result.label}</span>
								</p>
								<p>{check.observed}</p>
								{check.reason ? <p>{check.reason}</p> : null}
							</li>
						))}
					</ul>
				</>
			) : null}
			{row.checks.some((check) => check.formula || check.evidence.length > 0) ? (
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
							<EvidenceButtons check={check} onOpen={props.onOpenEvidence} />
						</li>
					))}
				</ul>
			) : null}
			{row.prices.length > 0 ? (
				<>
					<h3>价格</h3>
					{row.prices.some((price) => !price.muted) ? (
						<dl className="prices">
							{row.prices
								.filter((price) => !price.muted)
								.map((price) => (
									<div key={price.label}>
										<dt>{price.label}</dt>
										<dd>{price.text}</dd>
									</div>
								))}
						</dl>
					) : null}
					{row.prices
						.filter((price) => price.muted)
						.map((price) => (
							<p className="quiet" key={price.text}>
								{price.text}
							</p>
						))}
				</>
			) : null}
		</aside>
	);
}

function EvidenceButtons(props: { check: CheckView; onOpen: (id: string) => void }) {
	if (props.check.evidence.length === 0) return null;
	return (
		<p>
			{props.check.evidence.map((item) => (
				<button key={item.id} className="text-button" type="button" onClick={() => props.onOpen(item.id)}>
					{item.title}
				</button>
			))}
		</p>
	);
}

export function EvidencePane(props: {
	row: CandidateRowView | null;
	evidence: EvidenceDetail | null;
	evidenceError: string | null;
	onOpenEvidence: (evidenceId: string) => void;
	onSelect: (id: string) => void;
	onClose: () => void;
}) {
	if (!props.row) {
		return (
			<aside className="detail" aria-label="所选型号">
				<p className="quiet">选择一行查看来源。</p>
			</aside>
		);
	}
	return (
		<EvidenceBody
			key={props.row.id}
			row={props.row}
			evidence={props.evidence}
			evidenceError={props.evidenceError}
			onOpenEvidence={props.onOpenEvidence}
			onSelect={props.onSelect}
			onClose={props.onClose}
		/>
	);
}
