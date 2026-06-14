/**
 * gmail_create_draft — create a Gmail DRAFT in the connected account.
 *
 * SAFETY: this module only ever calls `users.drafts.create`. It does not
 * import, wrap, or expose `drafts.send` or `messages.send`. The "never send"
 * guarantee is structural: there is no send path in this toolset. Keep it that
 * way — do not add a send helper here.
 *
 * Auth: a Google OAuth2 client with a stored refresh token. The minimal usable
 * scope is `https://www.googleapis.com/auth/gmail.compose`. (Google has no
 * scope that allows draft creation but forbids sending, so the guarantee is
 * enforced in code, not by the scope.)
 *
 * Runtime: Node 18+. Depends on `googleapis`.
 */

import { google } from "googleapis";
import type { GmailDraftOutput, ToolError, ToolFail, ToolResult } from "./types.js";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function fail(error: ToolError): ToolFail {
  return { ok: false, status: 0, error };
}

export interface GmailDraftInput {
  to: string;
  subject: string;
  /** Plain-text body. */
  body: string;
  /** Optional: thread to attach the draft to (a reply draft). */
  threadId?: string;
}

/** Build the OAuth2 client from env. Kept internal so the only public surface
 *  is `gmail_create_draft`. */
function gmailAuth(): InstanceType<typeof google.auth.OAuth2> | ToolFail {
  const clientId = process.env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    return fail({
      code: "not_configured",
      message:
        "Gmail OAuth is not configured. Set GMAIL_OAUTH_CLIENT_ID, " +
        "GMAIL_OAUTH_CLIENT_SECRET, and GMAIL_OAUTH_REFRESH_TOKEN.",
      retryable: false,
    });
  }
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

/** RFC 2822 message, base64url-encoded as Gmail expects.
 *  The Subject is RFC 2047 encoded and the body is base64 (Content-Transfer-
 *  Encoding: base64) so non-ASCII (smart quotes, accented names, emoji) — which
 *  outreach emails almost always contain — survives strict MIME parsers. A
 *  `7bit` declaration with raw UTF-8 bytes would be an RFC 2045 violation. */
function encodeMessage(to: string, subject: string, body: string): string {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  // base64 body, wrapped at 76 chars per RFC 2045.
  const encodedBody = Buffer.from(body, "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");
  const lines = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodedBody,
  ];
  return Buffer.from(lines.join("\r\n"), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function gmail_create_draft(
  input: GmailDraftInput
): Promise<ToolResult<GmailDraftOutput>> {
  if (!input?.to || !EMAIL_RE.test(input.to)) {
    return fail({ code: "invalid_request", message: "`to` must be a valid email.", retryable: false });
  }
  if (typeof input.subject !== "string" || typeof input.body !== "string") {
    return fail({
      code: "invalid_request",
      message: "`subject` and `body` are required strings.",
      retryable: false,
    });
  }

  const auth = gmailAuth();
  if ("ok" in auth) return auth; // ToolFail

  // `userId` is "me" for the authorized account, or an explicit account id.
  const userId = process.env.GMAIL_ACCOUNT_ID || "me";
  const gmail = google.gmail({ version: "v1", auth });

  try {
    const res = await gmail.users.drafts.create({
      userId,
      requestBody: {
        message: {
          raw: encodeMessage(input.to, input.subject, input.body),
          ...(input.threadId ? { threadId: input.threadId } : {}),
        },
      },
    });
    const draft = res.data;
    return {
      ok: true,
      status: res.status ?? 200,
      data: {
        draft_id: draft.id ?? "",
        message_id: draft.message?.id ?? "",
        thread_id: draft.message?.threadId ?? "",
      },
    };
  } catch (e) {
    const status =
      typeof e === "object" && e && "code" in e && typeof (e as { code: unknown }).code === "number"
        ? (e as { code: number }).code
        : 0;
    const retryable = status === 0 || status === 429 || status >= 500;
    return fail({
      code: status === 401 || status === 403 ? "unauthorized" : retryable ? "network" : "internal",
      message: `Gmail draft creation failed: ${String(e)}`,
      retryable,
    });
  }
}
