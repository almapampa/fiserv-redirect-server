import { google } from 'googleapis';
import { procesarVentaConfirmada } from '../lib/ventas.js';

import { Resend } from 'resend';

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

// Formatea un número ARS a "$ 315.000" (mismo criterio que el resto del proyecto)
function fmtARS(amount) {
  if (amount === null || amount === undefined || amount === '') return '';
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(n)) return '';
  return '$ ' + Math.round(n).toLocaleString('es-AR');
}

// Lee la fila del pedido en la planilla por OID (columna P, índice 15)
// y devuelve el array de datos de esa fila (o null si no la encuentra).
async function leerFilaPedido(oid) {
  if (!oid) return null;
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Sheet1!A:Y',
  });
  const rows = response.data.values || [];
  const row = rows.find(r => r[15] === oid);
  return row || null;
}

// Envía el email de confirmación al cliente que pagó con tarjeta.
// Lee todos los datos de la fila del Sheet (igual que procesarVentaConfirmada).
async function enviarEmailConfirmacionCliente(oid) {
  const datos = await leerFilaPedido(oid);
  if (!datos) {
    console.error('fiserv-redirect: no se encontró la fila para el email. OID:', oid);
    return;
  }

  const email = datos[2];                 // C — email del cliente
  if (!email) {
    console.error('fiserv-redirect: la fila no tiene email. OID:', oid);
    return;
  }

  const nombreCompleto = (datos[1] || '').trim();          // B — nombre completo
  const primerNombre = nombreCompleto.split(' ')[0] || nombreCompleto;
  const productos = datos[16] || '';                        // Q — productos
  const total = fmtARS(datos[12] || datos[10]);             // M — monto real (K de respaldo)

  // Dirección: E/F/G/H/I = índices 4/5/6/7/8, país en J = índice 9
  const address = datos[4] || '';
  const apartment = datos[5] || '';
  const city = datos[6] || '';
  const province = datos[7] || '';
  const postalCode = datos[8] || '';
  const country = datos[9] || '';
  const paisLabel = country === 'CL' ? 'Chile' : (country === 'US' ? 'Estados Unidos' : 'Argentina');
  const direccion =
    `${address}${apartment ? ', ' + apartment : ''}\n` +
    `${city}, ${province}${postalCode ? ', CP ' + postalCode : ''}\n` +
    `${paisLabel}`;

  await resend.emails.send({
    from: 'Alma Pampa <notificaciones@almapampa.com>',
    to: email,
    replyTo: STORE_EMAIL,
    subject: '¡Tu pago fue confirmado! — Alma Pampa',
    text: `
Hola ${primerNombre},

¡Excelente noticia! Confirmamos la recepción de tu pago.
Tu pedido está en preparación y pronto te enviaremos los detalles del envío.

RESUMEN DE TU PEDIDO
─────────────────────────────
${productos}
${total ? 'Total pagado: ' + total : ''}
Pedido ID: ${oid || ''}
─────────────────────────────

DIRECCIÓN DE ENVÍO
${direccion}

Si tenés alguna consulta, responde este email o escribinos por WhatsApp.
¡Muchas gracias por tu compra!

Alma Pampa
    `.trim(),
  });

  console.log('fiserv-redirect: email de confirmación enviado a', email, '| OID:', oid);
}

async function updateOrderStatus(oid, transactionId, status, approvalCode) {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Sheet1!A:Q',
  });

  const rows = response.data.values || [];
  // El oid está en columna P (índice 15)
  const rowIndex = rows.findIndex(row => row[15] === oid);
  
  if (rowIndex !== -1) {
    const sheetRow = rowIndex + 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `Sheet1!O${sheetRow}`,
      valueInputOption: 'RAW',
      resource: { 
      values: [[status]] 
      },
    });
  }
}

export default async function handler(req, res) {

  if (req.method === 'POST' && req.url.includes('/fiserv-redirect')) {
    try {
      const {
        approval_code,
        oid,
        refnumber,
        status,
        txndate_processed,
        ipgTransactionId,
        chargetotal,
        fail_reason,
        ccbrand,
      } = req.body;

      const isSuccess = status === 'APPROVED' || 
                        (approval_code && approval_code.startsWith('Y'));

      try {
        if (isSuccess) {
          // Pago aprobado por Fiserv → crear orden en Shopify (descuenta stock),
          // marcar APROBADO en la planilla y enviar el Purchase a Meta.
          // Es el mismo circuito que usan los pagos manuales al confirmarse.
          const resultado = await procesarVentaConfirmada(oid || '', 'APROBADO');
          if (resultado.creada) {
            console.log('fiserv-redirect: orden', resultado.nombre, 'creada. OID:', oid);
          } else if (resultado.yaExistia) {
            console.log('fiserv-redirect: la orden', resultado.nombre, 'ya existía. OID:', oid);
          } else {
            console.error('fiserv-redirect: no se pudo crear la orden:', resultado.motivo, '| OID:', oid);
          }
          // ── NUEVO: email de confirmación al cliente ──────────────
          // Solo cuando la orden se ACABA de crear. Si Fiserv reintenta el POST,
          // procesarVentaConfirmada devuelve "yaExistia" y NO reenviamos el email
          // → el cliente recibe uno solo. Va en su propio try/catch: si el email
          // falla, igual se redirige a la página de éxito. Nunca cortamos el flujo.
          if (resultado.creada) {
            try {
              await enviarEmailConfirmacionCliente(oid || '');
            } catch (emailError) {
              console.error('fiserv-redirect: falló el envío del email al cliente. OID:', oid, emailError);
            }
          }
        } else {
          // Pago rechazado → solo marcar el estado, sin orden ni evento a Meta.
          await updateOrderStatus(oid || '', ipgTransactionId, 'RECHAZADO', approval_code);
        }
      } catch (procesoError) {
        // Nunca cortamos el flujo: el cliente tiene que ser redirigido igual.
        console.error('Error procesando venta aprobada:', procesoError);
      }

      const shopifyBaseUrl = isSuccess
        ? 'https://almapampa.com/pages/payment-success'
        : 'https://almapampa.com/pages/payment-failed';

      const params = new URLSearchParams({
        approval_code: approval_code || '',
        oid: oid || '',
        status: status || '',
        amount: chargetotal || '',
        transaction_id: ipgTransactionId || '',
        ref: refnumber || '',
        date: txndate_processed || '',
        ...(fail_reason && { error: fail_reason }),
        ...(ccbrand && { brand: ccbrand }),
      });

      return res.redirect(302, `${shopifyBaseUrl}?${params.toString()}`);

    } catch (error) {
      console.error('Error procesando respuesta Fiserv:', error);
      return res.redirect(302, 
        'https://almapampa.com/pages/payment-failed?error=Error+procesando+pago'
      );
    }
  }

  return res.status(405).json({ error: 'Método no permitido' });
}
