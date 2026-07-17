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

// ─── NORMALIZACIÓN DE paymentMethod ──────────────────────────────
// Durante la transición aceptamos el viejo 'transfer' (=transfer-cl).
// Esto permite deployar el servidor sin coordinar exactamente con el front.
function normalizeMethod(method) {
  if (method === 'transfer') return 'transfer-cl';
  return method;
}

// ─── FORMATEADORES ───────────────────────────────────────────────
function fmtARS(amount) {
  if (amount === null || amount === undefined || amount === '') return '';
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  return '$ ' + Math.round(n).toLocaleString('es-AR');
}

async function saveToSheets(d, status) {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  // Para transferencia AR: el monto final es el que figura como arsTotal
  // (ya viene con 25% OFF desde el frontend). displayTotal se deja igual.
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
    d.arsTotal || '',       // monto final en ARS (ya con descuento aplicado si corresponde)
    '',                     // shippingCost (no aplica)
    d.arsTotal || '',       // finalTotal en ARS
    '1',                    // installments
    status,                 // PENDIENTE_TRANSFERENCIA o PENDIENTE_MP
    d.oid || '',
    d.cartItems || '',
    d.notes || '',
    d.currency || 'ARS',
    d.displayTotal || '',
    JSON.stringify(d.lineItems || []),   // columna U — IDs y cantidades de productos (para crear la orden en Shopify)
    '',                                  // columna V — reservada: nº de orden de Shopify (la escribe confirm-payment)
    d.fbp || '',                         // columna W — cookie _fbp del navegador
    d.fbc || '',                         // columna X — cookie _fbc (o reconstruida desde fbclid)
    d.eventId || '',                     // columna Y — ID único del evento (deduplicación en Meta)
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Sheet1!A1',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',   // fuerza fila nueva anclada en la columna A
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
    const method = normalizeMethod(d.paymentMethod);

    const methodLabels = {
      'transfer-ar': '🏦 Transferencia (AR) — 25% OFF',
      'transfer-cl': '🏦 Transferencia bancaria (Chile)',
      'mercadopago': '💳 MercadoPago (Chile)',
      'fiserv':      '💳 Tarjeta (Fiserv)',
    };
    const methodLabel = methodLabels[method] || method;
    const fecha = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Mendoza' });

    // ── GUARDAR EN GOOGLE SHEETS ─────────────────────────────────
    if (method === 'transfer-ar' || method === 'transfer-cl' || method === 'mercadopago') {
      const status = method === 'mercadopago' ? 'PENDIENTE_MP' : 'PENDIENTE_TRANSFERENCIA';
      try {
        await saveToSheets(d, status);
      } catch (sheetsError) {
        console.error('Error guardando en Sheets:', sheetsError);
      }
    }

    // ── EMAIL A VOS (la tienda) ──────────────────────────────────
    const storeSubject = `[Alma Pampa] Nuevo pedido — ${methodLabel} — ${d.firstName} ${d.lastName}`;

    // Armado del bloque de monto — para AR muestro ambos si hay descuento
    let montoBlock = '';
    if (method === 'transfer-ar' && d.originalTotal && d.originalTotal !== d.arsTotal) {
      const ahorro = parseFloat(d.originalTotal) - parseFloat(d.arsTotal);
      montoBlock =
        `Monto original (ARS):        ${fmtARS(d.originalTotal)}\n` +
        `Descuento (25% transfer.):   -${fmtARS(ahorro)}\n` +
        `Monto a cobrar (ARS):        ${fmtARS(d.arsTotal)}`;
    } else if (d.currency && d.currency !== 'ARS') {
      montoBlock =
        `Monto (${d.currency}): ${d.displayTotal}\n` +
        `Monto (ARS): ${fmtARS(d.arsTotal)}`;
    } else {
      montoBlock = `Monto (ARS): ${fmtARS(d.arsTotal)}`;
    }

    const paisLabel = d.country === 'CL' ? 'Chile' : (d.country === 'US' ? 'Estados Unidos' : 'Argentina');

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
${montoBlock}

ENVÍO
${d.address}${d.apartment ? ', ' + d.apartment : ''}
${d.city}, ${d.province}${d.postalCode ? ', CP ' + d.postalCode : ''}
${paisLabel}

${d.notes ? 'NOTAS\n' + d.notes + '\n' : ''}
${'─'.repeat(40)}
Pedido ID: ${d.oid}
Fecha: ${fecha}
    `.trim();

    // Link mágico para confirmar el pago (abre confirm-payment.js)
    const totalParaConfirmUrl = method === 'transfer-ar' ? fmtARS(d.arsTotal) : (d.displayTotal || '');
    const confirmUrl = 'https://fiserv-redirect-server.vercel.app/confirm-payment?' +
      'email=' + encodeURIComponent(d.email) +
      '&name=' + encodeURIComponent(d.firstName) +
      '&oid=' + encodeURIComponent(d.oid || '') +
      '&items=' + encodeURIComponent(d.cartItems || '') +
      '&total=' + encodeURIComponent(totalParaConfirmUrl) +
      '&token=' + encodeURIComponent(process.env.CONFIRM_SECRET_TOKEN);

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

    if (method === 'transfer-ar') {
      clientSubject = 'Tu pedido en Alma Pampa — Datos para transferir';

      const resumenMontos = d.originalTotal && d.originalTotal !== d.arsTotal
        ? `Subtotal:                ${fmtARS(d.originalTotal)}\n` +
          `Descuento por transfer.: -${fmtARS(parseFloat(d.originalTotal) - parseFloat(d.arsTotal))} (25%)\n` +
          `─────────────────────────\n` +
          `TOTAL A TRANSFERIR:     ${fmtARS(d.arsTotal)}`
        : `TOTAL A TRANSFERIR: ${fmtARS(d.arsTotal)}`;

      clientBody = `
Hola ${d.firstName},

¡Gracias por tu compra! Recibimos tu pedido. Para confirmarlo, transferí el monto indicado a la siguiente cuenta:

DATOS PARA TRANSFERIR
─────────────────────────────
Titular:  Cecilia Laura Brattoli
CUIT:     27-21605652-9
Banco:    Mercado Pago
Alias:    alma.pampa.mdz
CVU:      0000003100042797656477
─────────────────────────────

${resumenMontos}

IMPORTANTE — Una vez realizada la transferencia:
• Envianos el comprobante por WhatsApp: https://wa.me/${WA_NUMBER}
• O respondé a este email con el comprobante adjunto

Apenas recibamos el comprobante, te enviamos la confirmación y preparamos tu pedido.

TU PEDIDO
${d.cartItems}

Dirección de envío:
${d.address}${d.apartment ? ', ' + d.apartment : ''}
${d.city}, ${d.province}${d.postalCode ? ', CP ' + d.postalCode : ''}, Argentina

Muchas gracias por tu compra,
Alma Pampa
      `.trim();

    } else if (method === 'transfer-cl') {
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

    } else if (method === 'mercadopago') {
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
