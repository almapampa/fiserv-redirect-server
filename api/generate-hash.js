// api/generate-hash.js
import crypto from 'crypto';

export default async function handler(req, res) {

  // Solo aceptar desde tu tienda
  res.setHeader('Access-Control-Allow-Origin', 'https://almapampa.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  // Recibir los parámetros del formulario desde el browser
  const { params } = req.body;

  if (!params || typeof params !== 'object') {
    return res.status(400).json({ error: 'Parámetros inválidos' });
  }

  // El secreto vive aquí, en el servidor. Nunca sale.
  const sharedSecret = process.env.FISERV_SHARED_SECRET;

  if (!sharedSecret) {
    return res.status(500).json({ error: 'Configuración incompleta' });
  }

  // Calcular el hash exactamente igual que antes,
  // pero ahora en el servidor
  const sortedKeys = Object.keys(params).sort();
  const stringToHash = sortedKeys.map(function(k) { return params[k]; }).join('|');
  const hash = crypto
    .createHmac('sha256', sharedSecret)
    .update(stringToHash)
    .digest('base64');

  return res.status(200).json({ hash });
}
