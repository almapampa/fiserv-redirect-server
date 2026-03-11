import { google } from 'googleapis';

function getGoogleAuth() {
  const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  return new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://almapampa.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  try {
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    const data = req.body;
    console.log('BODY COMPLETO:', JSON.stringify(data));
    const row = [
      new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Mendoza' }),
      (data.firstName || '') + ' ' + (data.lastName || ''),
      data.email || '',
      data.phone || '',
      data.address || '',
      data.apartment || '',
      data.city || '',
      data.province || '',
      data.postalCode || '',
      data.country || '',
      data.cartTotal || '',
      data.shippingCost || '',
      data.finalTotal || '',
      data.installments || '',
      'PENDIENTE DE PAGO',
      data.oid || '',
      data.cartItems || '',
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:Q',
      valueInputOption: 'RAW',
      resource: { values: [row] },
    });

    return res.status(200).json({ ok: true });

  } catch (error) {
    console.error('Error guardando en Sheets:', error);
    return res.status(500).json({ error: 'Error guardando pedido' });
  }
}
