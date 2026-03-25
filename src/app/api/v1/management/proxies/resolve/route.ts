import { resolveProxyScopeState } from "@/lib/localDb";
import { createErrorResponse, createErrorResponseFromUnknown } from "@/lib/api/errorResponse";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

function parseScope(scope: string | null) {
  const value = String(scope || "").toLowerCase();
  if (!value) return { scope: "global" as const, valid: true };
  if (value === "provider") return { scope: "provider" as const, valid: true };
  if (value === "combo") return { scope: "combo" as const, valid: true };
  if (value === "key" || value === "account") return { scope: "key" as const, valid: true };
  return { scope: null, valid: false };
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);
    const { scope, valid } = parseScope(searchParams.get("scope"));
    const scopeId = searchParams.get("scope_id");

    if (!valid || !scope) {
      return createErrorResponse({
        status: 400,
        message: "scope must be one of: global, provider, combo, key",
        type: "invalid_request",
      });
    }

    if (scope !== "global" && !scopeId?.trim()) {
      return createErrorResponse({
        status: 400,
        message: "scope_id is required for provider/combo/key scope",
        type: "invalid_request",
      });
    }

    const resolved = await resolveProxyScopeState(scope, scopeId || null);
    return Response.json(resolved);
  } catch (error) {
    return createErrorResponseFromUnknown(error, "Failed to resolve proxy scope state");
  }
}
