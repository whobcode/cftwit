// Outbound email through Cloudflare Email Sending (the send_email binding).
// The From domain must be onboarded under Email Sending in the dashboard, or sends fail.

export async function sendSignInLink(env: Env, to: string, link: string): Promise<boolean> {
  const text = [
    "Here's your link to sign in to cftwit and choose a password:",
    "",
    link,
    "",
    "It works once and expires in an hour. If you didn't ask for this, you can ignore this email.",
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f6f5f9;font-family:system-ui,sans-serif">
  <div style="max-width:480px;margin:0 auto;padding:32px 24px;color:#17151f">
    <h1 style="color:#6d4aff;font-size:24px;margin:0 0 16px">cftwit</h1>
    <p>Here's your link to sign in and choose a password:</p>
    <p style="margin:24px 0"><a href="${link}" style="background:#6d4aff;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:700">Sign in to cftwit</a></p>
    <p style="color:#6b6779;font-size:14px">It works once and expires in an hour. If you didn't ask for this, you can ignore this email.</p>
  </div></body></html>`;
  try {
    await env.EMAIL.send({
      to,
      from: { email: env.MAIL_FROM, name: "cftwit" },
      subject: "Your cftwit sign-in link",
      text,
      html,
    } as never);
    return true;
  } catch (err) {
    console.error("mail: sign-in link failed", String(err));
    return false;
  }
}
