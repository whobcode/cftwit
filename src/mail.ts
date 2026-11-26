// Outbound email through Cloudflare Email Sending (the send_email binding).
//
// The From domain must be onboarded under Email Sending, and the account must be
// on Workers Paid: sending to anyone who is not already a verified destination
// address on the account is a paid feature. Without either, every send fails
// with E_EMAIL_SENDING_NOT_READY or E_RECIPIENT_PLAN_RESTRICTED.
//
// Note when checking whether this works: sends from a Worker show up in the
// Email Routing summary as "dropped" even when they were delivered. Email
// Sending metrics are the ones that mean anything here.

export async function sendSignInLink(env: Env, to: string, link: string): Promise<boolean> {
  const text = [
    "Here's your link to sign in and choose a password:",
    "",
    link,
    "",
    "It works once and expires in an hour. If you didn't ask for this, you can ignore this email.",
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#07070a;font-family:system-ui,sans-serif">
  <div style="max-width:480px;margin:0 auto;padding:32px 24px;color:#ededf2">
    <h1 style="color:#ff2a2a;font-size:28px;font-weight:700;margin:0 0 16px">me</h1>
    <p>Here's your link to sign in and choose a password:</p>
    <p style="margin:24px 0"><a href="${link}" style="background:#ff2a2a;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:700">Sign in</a></p>
    <p style="color:#8b8b99;font-size:14px">It works once and expires in an hour. If you didn't ask for this, you can ignore this email.</p>
  </div></body></html>`;
  try {
    await env.EMAIL.send({
      to,
      from: { email: env.MAIL_FROM, name: "me" },
      subject: "Your sign-in link",
      text,
      html,
    } as never);
    return true;
  } catch (err) {
    // The Cloudflare error code is the useful part — E_RECIPIENT_PLAN_RESTRICTED,
    // E_EMAIL_SENDING_NOT_READY, E_RECIPIENT_SUPPRESSED and so on each mean
    // something different and need a different fix.
    console.error("mail: sign-in link failed", { to, code: (err as { name?: string })?.name, error: String(err) });
    return false;
  }
}
