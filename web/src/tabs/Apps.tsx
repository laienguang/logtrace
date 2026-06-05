import { useState } from "react";
import useSWR from "swr";
import { api, fetcher, type AppItem } from "../api";

export function Apps() {
	const { data, mutate, error } = useSWR<{ items: AppItem[] }>("/api/apps", fetcher);
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState("");
	const [created, setCreated] = useState<AppItem | null>(null);
	const [busy, setBusy] = useState(false);
	const [opError, setOpError] = useState<string | null>(null);
	const [secretApp, setSecretApp] = useState<AppItem | null>(null);
	const [deleting, setDeleting] = useState<{ app: AppItem; eventCount: number } | null>(null);

	const create = async () => {
		if (!newName.trim()) return;
		setBusy(true); setOpError(null);
		try {
			const res = await api<AppItem>("/api/apps", { method: "POST", body: JSON.stringify({ name: newName.trim() }) });
			setCreated(res);
			setNewName("");
			mutate();
		} catch (e: any) {
			setOpError(String(e?.message || e));
		} finally {
			setBusy(false);
		}
	};

	const patch = async (key: string, body: any) => {
		setOpError(null);
		try {
			await api(`/api/apps/${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify(body) });
			mutate();
		} catch (e: any) {
			setOpError(String(e?.message || e));
		}
	};

	const openDelete = async (app: AppItem) => {
		setOpError(null);
		try {
			const detail = await api<AppItem>(`/api/apps/${encodeURIComponent(app.app_key)}`);
			setDeleting({ app, eventCount: detail.event_count ?? 0 });
		} catch (e: any) {
			setOpError(String(e?.message || e));
		}
	};

	const doDelete = async () => {
		if (!deleting) return;
		setBusy(true); setOpError(null);
		try {
			await api(`/api/apps/${encodeURIComponent(deleting.app.app_key)}`, { method: "DELETE" });
			setDeleting(null);
			mutate();
		} catch (e: any) {
			setOpError(String(e?.message || e));
		} finally {
			setBusy(false);
		}
	};

	const items = data?.items || [];

	return (
		<>
			{error && <div className="error-box">{String(error)}</div>}
			{opError && <div className="error-box">{opError}</div>}
			<div className="panel">
				<div className="controls" style={{ marginBottom: 12 }}>
					<h2 style={{ margin: 0, flex: 1 }}>应用</h2>
					<button onClick={() => setCreating(true)}>新建应用</button>
				</div>
				{items.length === 0 ? (
					<div className="empty">
						还没有应用。点「新建应用」生成第一组 app_id / app_key / app_secret，
						<br />然后用 app_key + app_secret 往 <code>POST /collect</code> 上报事件。
					</div>
				) : (
					<table className="tbl">
						<thead>
							<tr>
								<th>app_id</th>
								<th>名称</th>
								<th>app_key</th>
								<th>app_secret</th>
								<th>状态</th>
								<th>创建者</th>
								<th>创建时间</th>
								<th>操作</th>
							</tr>
						</thead>
						<tbody>
							{items.map((a) => (
								<tr key={a.app_key}>
									<td><Copyable text={a.app_id} /></td>
									<td>
										<EditableName name={a.name} onSave={(n) => patch(a.app_key, { name: n })} />
									</td>
									<td><Copyable text={a.app_key} /></td>
									<td>
										<button className="copy" onClick={() => setSecretApp(a)}>查看</button>
									</td>
									<td>
										<span className={a.status === "active" ? "tag good" : "tag bad"}>{a.status}</span>
									</td>
									<td className="muted">{a.user_name || a.user_email || a.user_id}</td>
									<td className="muted">{new Date(a.created_at).toLocaleString("zh-CN", { hour12: false })}</td>
									<td>
										<div className="row-actions">
											{a.status === "active" ? (
												<button className="danger" onClick={() => confirm(`吊销 ${a.name}？\n吊销后用此 app_key/app_secret 上报会被拒。`) && patch(a.app_key, { status: "revoked" })}>吊销</button>
											) : (
												<>
													<button className="ghost" onClick={() => patch(a.app_key, { status: "active" })}>恢复</button>
													<button className="danger" onClick={() => openDelete(a)}>删除</button>
												</>
											)}
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>

			{creating && (
				<div className="modal-bg" onClick={() => !busy && setCreating(false)}>
					<div className="modal" onClick={(e) => e.stopPropagation()}>
						<h3>新建应用</h3>
						<div className="field">
							<label>名称（显示用，可随时改；不影响历史事件归属）</label>
							<input
								autoFocus
								value={newName}
								onChange={(e) => setNewName(e.target.value)}
								placeholder="如 main-site / app-android"
							/>
						</div>
						<div className="actions">
							<button className="ghost" disabled={busy} onClick={() => setCreating(false)}>取消</button>
							<button disabled={busy || !newName.trim()} onClick={create}>{busy ? "创建中…" : "创建"}</button>
						</div>
					</div>
				</div>
			)}

			{created && (
				<div className="modal-bg" onClick={() => { setCreated(null); setCreating(false); }}>
					<div className="modal" onClick={(e) => e.stopPropagation()}>
						<h3>已创建：{created.name}</h3>
						<p className="muted">下面三个值之后在列表里也可以再次查看。上报时只需带 app_key + app_secret 两个 header。</p>
						<div className="field">
							<label>app_id（稳定标识，事件入库用它，永不可改）</label>
							<Copyable text={created.app_id} />
						</div>
						<div className="field">
							<label>app_key（X-App-Key）</label>
							<Copyable text={created.app_key} />
						</div>
						<div className="field">
							<label>app_secret（X-App-Secret）</label>
							<Copyable text={created.app_secret} />
						</div>
						<div className="actions">
							<button onClick={() => { setCreated(null); setCreating(false); }}>完成</button>
						</div>
					</div>
				</div>
			)}

			{deleting && (
				<DeleteConfirm
					app={deleting.app}
					eventCount={deleting.eventCount}
					busy={busy}
					onCancel={() => setDeleting(null)}
					onConfirm={doDelete}
				/>
			)}

			{secretApp && (
				<div className="modal-bg" onClick={() => setSecretApp(null)}>
					<div className="modal" onClick={(e) => e.stopPropagation()}>
						<h3>查看 app_secret</h3>
						<p className="muted">应用：{secretApp.name}</p>
						<div className="field">
							<label>app_secret（X-App-Secret）</label>
							<Copyable text={secretApp.app_secret} />
						</div>
						<div className="actions">
							<button onClick={() => setSecretApp(null)}>关闭</button>
						</div>
					</div>
				</div>
			)}
		</>
	);
}

function DeleteConfirm({
	app, eventCount, busy, onCancel, onConfirm,
}: {
	app: AppItem; eventCount: number; busy: boolean;
	onCancel: () => void; onConfirm: () => void;
}) {
	const [typed, setTyped] = useState("");
	const ok = typed === app.name;
	return (
		<div className="modal-bg" onClick={() => !busy && onCancel()}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h3 style={{ color: "var(--danger)" }}>删除应用「{app.name}」</h3>
				<p className="muted">
					此操作 <strong>不可撤销</strong>，将同时永久删除该应用的
					<strong style={{ color: "var(--danger)" }}> {eventCount} </strong>
					条历史事件。
				</p>
				<div className="field">
					<label>请输入应用名 <code>{app.name}</code> 以确认</label>
					<input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
				</div>
				<div className="actions">
					<button className="ghost" disabled={busy} onClick={onCancel}>取消</button>
					<button className="danger" disabled={busy || !ok} onClick={onConfirm}>
						{busy ? "删除中…" : "确认删除"}
					</button>
				</div>
			</div>
		</div>
	);
}

function Copyable({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<span
			className="copy"
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(text);
					setCopied(true);
					setTimeout(() => setCopied(false), 1200);
				} catch { /* noop */ }
			}}
			title="点击复制"
		>
			{copied ? "已复制" : text}
		</span>
	);
}

function EditableName({ name, onSave }: { name: string; onSave: (n: string) => void }) {
	const [editing, setEditing] = useState(false);
	const [val, setVal] = useState(name);
	if (!editing) {
		return (
			<span style={{ cursor: "pointer" }} onClick={() => { setVal(name); setEditing(true); }}>
				{name} <span className="muted">✎</span>
			</span>
		);
	}
	return (
		<span>
			<input
				autoFocus
				value={val}
				onChange={(e) => setVal(e.target.value)}
				onBlur={() => { setEditing(false); if (val.trim() && val !== name) onSave(val.trim()); }}
				onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditing(false); }}
				style={{ width: 160 }}
			/>
		</span>
	);
}

function confirm(msg: string): boolean {
	return window.confirm(msg);
}
