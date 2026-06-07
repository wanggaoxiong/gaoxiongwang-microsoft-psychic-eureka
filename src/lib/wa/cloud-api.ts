import axios from 'axios';

export type WaTextMessage = {
  to: string;
  text: string;
  phoneNumberId?: string;
  accessToken?: string;
};

export type WaImageMessage = {
  to: string;
  imageUrl: string;
  caption?: string;
  phoneNumberId?: string;
  accessToken?: string;
};

function resolveCreds(input: { phoneNumberId?: string; accessToken?: string }) {
  return {
    phoneNumberId: input.phoneNumberId ?? process.env.WA_PHONE_NUMBER_ID,
    accessToken: input.accessToken ?? process.env.WA_ACCESS_TOKEN
  };
}

export async function sendWhatsAppText(input: WaTextMessage) {
  const { phoneNumberId, accessToken } = resolveCreds(input);

  if (!phoneNumberId || !accessToken) {
    return {
      ok: false,
      dryRun: true,
      reason: 'WA_PHONE_NUMBER_ID or WA_ACCESS_TOKEN is not configured',
      payload: { to: input.to, text: input.text }
    };
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: input.to,
        type: 'text',
        text: { preview_url: false, body: input.text }
      },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return { ok: true, dryRun: false, data: response.data };
  } catch (e: unknown) {
    const reason = extractAxiosError(e);
    return { ok: false, dryRun: false, reason };
  }
}

export async function sendWhatsAppImage(input: WaImageMessage) {
  const { phoneNumberId, accessToken } = resolveCreds(input);

  if (!phoneNumberId || !accessToken) {
    return {
      ok: false,
      dryRun: true,
      reason: 'WA_PHONE_NUMBER_ID or WA_ACCESS_TOKEN is not configured',
      payload: { to: input.to, imageUrl: input.imageUrl }
    };
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: input.to,
        type: 'image',
        image: { link: input.imageUrl, caption: input.caption }
      },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return { ok: true, dryRun: false, data: response.data };
  } catch (e: unknown) {
    return { ok: false, dryRun: false, reason: extractAxiosError(e) };
  }
}

function extractAxiosError(e: unknown): string {
  const err = e as { response?: { data?: { error?: { message?: string } } }; message?: string };
  return (
    err?.response?.data?.error?.message ||
    err?.message ||
    'unknown error'
  );
}

export function verifyWebhookToken(mode: string | null, token: string | null, challenge: string | null) {
  const expected = process.env.WA_WEBHOOK_VERIFY_TOKEN ?? 'dev-verify-token';

  if (mode === 'subscribe' && token === expected && challenge) {
    return challenge;
  }

  return null;
}
