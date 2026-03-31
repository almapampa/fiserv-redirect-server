import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
const NOTIFY_EMAIL = 'almapampamendoza@gmail.com';

export default async function handler(req, res) {
  // CORS headers — deben ir SIEMPRE, antes de cualquier chequeo
  res.setHeader('Access-Control-Allow-Origin', 'https://almapampa.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'false');

  // Preflight OPTIONS — responder inmediatamente con 204
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  try {
    const d = req.body;

    const montoLine = d.currency && d.currency !== 'ARS'
      ? `Monto (${d.currency}): ${d.displayTotal}\nMonto (ARS): $${d.arsTotal}`
      : `Monto (ARS): $${d.arsTotal}`;

    const methodLabels = {
      transfer:    '🏦 Transferencia bancaria',
      mercadopago: '💳 MercadoPago',
      fiserv:      '💳 Tarjeta (Fiserv)',
    };
    const methodLabel = methodLabels[d.paymentMethod] || d.paymentMethod;

    const subject = `[Alma Pampa] Nuevo pedido — ${methodLabel} — ${d.firstName} ${d.lastName}`;

    const body = `
NUEVO PEDIDO — ${methodLabel.toUpperCase()}
${'─'.repeat(40)}

CLIENTE
Nombre:    ${d.firstName} ${d.lastName}
Email:     ${d.email}
Teléfono:  ${d.phone}

PRODUCTOS
${d.cartItems}

MONTO
${montoLine}

ENVÍO
${d.address}${d.apartment ? ', ' + d.apartment : ''}
${d.city}, ${d.province}${d.postalCode ? ', CP ' + d.postalCode : ''}
${d.country === 'CL' ? 'Chile' : d.country === 'AR' ? 'Argentina' : d.country}

${d.notes ? 'NOTAS\n' + d.notes + '\n' : ''}
${'─'.repeat(40)}
Pedido ID: ${d.oid}
Fecha: ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Mendoza' })}
    `.trim();

    await resend.emails.send({
      from: 'Alma Pampa <notificaciones@almapampa.com>',
      to: NOTIFY_EMAIL,
      subject,
      text: body,
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error enviando notificación:', error);
    return res.status(500).json({ error: 'Error enviando email' });
  }
}
