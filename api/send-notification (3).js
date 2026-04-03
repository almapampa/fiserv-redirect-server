import { Resend } from 'resend';
import { google } from 'googleapis';

const resend = new Resend(process.env.RESEND_API_KEY);
const STORE_EMAIL = 'almapampamendoza@gmail.com';
const WA_NUMBER = '5492614724190';

function getGoogleAuth() {
  const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  return new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function saveToSheets(d, status) {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const row = [
    new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Mendoza' }),
    (d.firstName || '') + ' ' + (d.lastName || ''),
    d.email || '',
    d.phone || '',
    d.address || '',
    d.apartment || '',
    d.city || '',
    d.province || '',
    d.postalCode || '',
    d.country || '',
    d.arsTotal || '',       // monto ARS (precio real del producto)
    '',                     // shippingCost (no aplica aún)
    d.arsTotal || '',       // finalTotal en ARS
    '1',                    // installments
    status,                 // PENDIENTE_TRANSFERENCIA o PENDIENTE_MP
    d.oid || '',
    d.cartItems || '',
    d.notes || '',
    d.currency || 'CLP',    // moneda del cliente
    d.displayTotal || '',   // monto en moneda del cliente (CLP)
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Sheet1!A:T',
    valueInputOption: 'RAW',
    resource: { values: [row] },
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://almapampa.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'false');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    const d = req.body;

    const methodLabels = {
      transfer:    '🏦 Transferencia bancaria',
      mercadopago: '💳 MercadoPago',
      fiserv:      '💳 Tarjeta (Fiserv)',
    };
    const methodLabel = methodLabels[d.paymentMethod] || d.paymentMethod;
    const fecha = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Mendoza' });

    // ── GUARDAR EN GOOGLE SHEETS ─────────────────────────────────
    if (d.paymentMethod === 'transfer' || d.paymentMethod === 'mercadopago') {
      const status = d.paymentMethod === 'transfer' ? 'PENDIENTE_TRANSFERENCIA' : 'PENDIENTE_MP';
      try {
        await saveToSheets(d, status);
      } catch (sheetsError) {
        // No cortar el flujo si Sheets falla — los emails siguen igual
        console.error('Error guardando en Sheets:', sheetsError);
      }
    }

    // ── EMAIL A VOS (la tienda) ──────────────────────────────────
    const storeSubject = `[Alma Pampa] Nuevo pedido — ${methodLabel} — ${d.firstName} ${d.lastName}`;
    const storeBody = `
NUEVO PEDIDO — ${methodLabel.toUpperCase()}
${'─'.repeat(40)}

CLIENTE
Nombre:    ${d.firstName} ${d.lastName}
Email:     ${d.email}
Teléfono:  ${d.phone}

PRODUCTOS
${d.cartItems}

MONTO
${d.currency && d.currency !== 'ARS'
  ? `Monto (${d.currency}): ${d.displayTotal}\nMonto (ARS): $${d.arsTotal}`
  : `Monto (ARS): $${d.arsTotal}`}

ENVÍO
${d.address}${d.apartment ? ', ' + d.apartment : ''}
${d.city}, ${d.province}${d.postalCode ? ', CP ' + d.postalCode : ''}
${d.country === 'CL' ? 'Chile' : 'Argentina'}

${d.notes ? 'NOTAS\n' + d.notes + '\n' : ''}
${'─'.repeat(40)}
Pedido ID: ${d.oid}
Fecha: ${fecha}
    `.trim();

    const confirmUrl = 'https://fiserv-redirect-server.vercel.app/confirm-payment?' +
      'email=' + encodeURIComponent(d.email) +
      '&name=' + encodeURIComponent(d.firstName) +
      '&oid=' + encodeURIComponent(d.oid || '') +
      '&items=' + encodeURIComponent(d.cartItems || '') +
      '&total=' + encodeURIComponent(d.displayTotal || '');

    const storeBodyWithLink = storeBody + '\n\n' +
      '─'.repeat(40) + '\n' +
      '👉 CONFIRMAR PAGO RECIBIDO (envía email al cliente automáticamente):\n' +
      confirmUrl;

    await resend.emails.send({
      from: 'Alma Pampa <notificaciones@almapampa.com>',
      to: STORE_EMAIL,
      subject: storeSubject,
      text: storeBodyWithLink,
    });

    // ── EMAIL AL CLIENTE ─────────────────────────────────────────
    let clientSubject = '';
    let clientBody = '';

    if (d.paymentMethod === 'transfer') {
      clientSubject = 'Tu pedido en Alma Pampa — Datos para transferir';
      clientBody = `
Hola ${d.firstName},

Recibimos tu pedido. Para confirmarlo, realizá la transferencia por ${d.displayTotal} a los siguientes datos:

DATOS BANCARIOS
─────────────────────────────
Titular:        ALMA PAMPA SPA
RUT:            77.557.836-K
Banco:          Mercado Pago
Tipo de cuenta: Cuenta Vista
Número:         1021769354
Monto:          ${d.displayTotal}
─────────────────────────────

Una vez transferido, envianos el comprobante por:
• WhatsApp: https://wa.me/${WA_NUMBER}
• Respondiendo este email

TU PEDIDO
${d.cartItems}

Dirección de envío:
${d.address}${d.apartment ? ', ' + d.apartment : ''}
${d.city}, ${d.province}${d.postalCode ? ', CP ' + d.postalCode : ''}, Chile

Muchas gracias por tu compra,
Alma Pampa
      `.trim();

    } else if (d.paymentMethod === 'mercadopago') {
      clientSubject = 'Tu pedido en Alma Pampa — Link de pago en camino';
      clientBody = `
Hola ${d.firstName},

Recibimos tu solicitud de pago por MercadoPago.

TU PEDIDO
${d.cartItems}
Monto: ${d.displayTotal}

Dirección de envío:
${d.address}${d.apartment ? ', ' + d.apartment : ''}
${d.city}, ${d.province}${d.postalCode ? ', CP ' + d.postalCode : ''}, Chile

En las próximas 24 horas te enviamos el link de pago a este correo.
Revisá también tu carpeta de spam por las dudas.

Muchas gracias por tu compra,
Alma Pampa
      `.trim();
    }

    if (clientSubject && d.email) {
      await resend.emails.send({
        from: 'Alma Pampa <notificaciones@almapampa.com>',
        to: d.email,
        replyTo: STORE_EMAIL,
        subject: clientSubject,
        text: clientBody,
      });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error enviando notificación:', error);
    return res.status(500).json({ error: 'Error enviando email' });
  }
}
