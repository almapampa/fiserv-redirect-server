import { google } from 'googleapis';

function getGoogleAuth() {
  const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  return new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function saveToSheets(orderData) {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  
  const row = [
    new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Mendoza' }),
    orderData.firstName + ' ' + orderData.lastName,
    orderData.email,
    orderData.phone,
    orderData.address,
    orderData.apartment || '',
    orderData.city,
    orderData.province,
    orderData.postalCode,
    orderData.country,
    orderData.cartTotal,
    orderData.shippingCost,
    orderData.finalTotal,
    orderData.installments,
    'PENDIENTE DE PAGO',
    orderData.oid || '',
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Sheet1!A:P',
    valueInputOption: 'RAW',
    resource: { values: [row] },
  });
}

async function updateOrderStatus(oid, transactionId, status, approvalCode) {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Sheet1!A:P',
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
        const sheetStatus = isSuccess ? 'APROBADO' : 'RECHAZADO';
        await updateOrderStatus(
          oid || '',
          ipgTransactionId,
          sheetStatus,
          approval_code
        );
      } catch (sheetError) {
        console.error('Error actualizando Sheets:', sheetError);
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
