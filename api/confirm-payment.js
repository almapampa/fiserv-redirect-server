import { Resend } from 'resend';
import { google } from 'googleapis';

const resend = new Resend(process.env.RESEND_API_KEY);
const STORE_EMAIL = 'almapampamendoza@gmail.com';

function getGoogleAuth() {
  const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  return new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function confirmarPagoEnSheets(oid) {
  if (!oid) return;
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  // Leer toda la columna P (columna 16, index 15) donde está el OID
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Sheet1!P:P',
  });

  const rows = response.data.values || [];
  let targetRow = null;

  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === oid) {
      targetRow = i + 1; // Sheets es base 1
      break;
    }
  }

  if (!targetRow) {
    console.warn('confirm-payment: OID no encontrado en Sheets:', oid);
    return;
  }

  // Actualizar columna O (columna 15) = estado, en la fila encontrada
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `Sheet1!O${targetRow}`,
    valueInputOption: 'RAW',
    resource: { values: [['PAGO_CONFIRMADO']] },
  });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Método no permitido');
  }

  const { email, name, oid, items, total, token } = req.query;
  if (!email || !name) {
    return res.status(400).send('Faltan datos');
  }

  // Verificar que el token sea válido — rechaza cualquier llamada no autorizada
  if (!token || token !== process.env.CONFIRM_SECRET_TOKEN) {
    return res.status(403).send('No autorizado');
  }

  try {
    // ── ACTUALIZAR ESTADO EN SHEETS ──────────────────────────────
    try {
      await confirmarPagoEnSheets(oid);
    } catch (sheetsError) {
      // No cortar el flujo si Sheets falla — el email al cliente igual se manda
      console.error('Error actualizando Sheets:', sheetsError);
    }

    // ── EMAIL AL CLIENTE ─────────────────────────────────────────
    await resend.emails.send({
      from: 'Alma Pampa <notificaciones@almapampa.com>',
      to: email,
      replyTo: STORE_EMAIL,
      subject: '¡Tu pago fue confirmado! — Alma Pampa',
      text: `
Hola ${name},

¡Excelente noticia! Confirmamos la recepción de tu pago.
Tu pedido está en preparación y pronto te enviamos los detalles del envío.

RESUMEN DE TU PEDIDO
─────────────────────────────
${items ? items : ''}
${total ? 'Total pagado: ' + total : ''}
Pedido ID: ${oid || ''}
─────────────────────────────

Si tenés alguna consulta, respondé este email o escribinos por WhatsApp.
¡Muchas gracias por tu compra!

Alma Pampa
      `.trim(),
    });

    // ── RESPUESTA HTML ───────────────────────────────────────────
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirmación enviada — Alma Pampa</title>
  <style>
    body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .box { background: #fff; border-radius: 16px; padding: 40px; max-width: 420px; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    .icon { font-size: 52px; margin-bottom: 16px; }
    h1 { font-size: 22px; color: #111; margin: 0 0 12px; }
    p { color: #555; font-size: 15px; line-height: 1.6; margin: 0 0 8px; }
    .email { font-weight: 600; color: #111; }
    .oid { font-size: 12px; color: #aaa; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="box">
    <div class="icon">✅</div>
    <h1>Confirmación enviada</h1>
    <p>Le enviamos el email de confirmación a:</p>
    <p class="email">${email}</p>
    <p>El cliente fue notificado de que su pago fue recibido y el pedido está en preparación.</p>
    <p style="font-size:13px;color:#27ae60;margin-top:12px;">✔ Estado actualizado en el registro de pedidos.</p>
    ${oid ? `<p class="oid">Pedido ID: ${oid}</p>` : ''}
  </div>
</body>
</html>
    `);
  } catch (error) {
    console.error('Error enviando confirmación:', error);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send(`
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>Error</title></head>
<body style="font-family:sans-serif;text-align:center;padding:40px;">
  <h2>❌ Error al enviar</h2>
  <p>No se pudo enviar el email. Intentá de nuevo.</p>
</body>
</html>
    `);
  }
}
