export interface UserRecord {
	user_id: string;
	email: string;
	name: string | null;
	avatar_url: string | null;
	created_at: number;
	last_login_at: number;
}

export interface GoogleUserProfile {
	user_id: string;
	email: string;
	name?: string;
	avatar_url?: string;
}

const USER_COLS = "user_id, email, name, avatar_url, created_at, last_login_at";

export async function getUserById(env: Env, userId: string): Promise<UserRecord | null> {
	const row = await env.DB.prepare(`SELECT ${USER_COLS} FROM users WHERE user_id = ?`)
		.bind(userId)
		.first<UserRecord>();
	return row ?? null;
}

export async function upsertGoogleUser(env: Env, profile: GoogleUserProfile): Promise<UserRecord> {
	const now = Date.now();
	const name = cleanOptional(profile.name);
	const avatarUrl = cleanOptional(profile.avatar_url);

	await env.DB.prepare(
		`INSERT INTO users (user_id, email, name, avatar_url, created_at, last_login_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
		   email = excluded.email,
		   name = excluded.name,
		   avatar_url = excluded.avatar_url,
		   last_login_at = excluded.last_login_at`,
	)
		.bind(profile.user_id, profile.email, name, avatarUrl, now, now)
		.run();

	const row = await getUserById(env, profile.user_id);
	if (!row) throw new Error("failed to load user");
	return row;
}

function cleanOptional(value: string | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}
