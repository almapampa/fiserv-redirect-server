import { google } from 'googleapis';
import { procesarVentaConfirmada } from '../lib/ventas.js';

function getGoogleAuth() {
  const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  return new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
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
