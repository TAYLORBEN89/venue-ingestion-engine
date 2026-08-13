import { createClient } from "@supabase/supabase-js";

// Service-role client only — this Worker never runs on behalf of a public
// user, so there's no anon/RLS-respecting path to offer here (mirrors
// apps/web's createServiceRoleClient, just reading from the Workers env
// binding instead of process.env).
export function createServiceRoleClient(env: CloudflareEnv) {
	return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}
