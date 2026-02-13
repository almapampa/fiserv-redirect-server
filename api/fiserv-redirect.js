// Servidor intermediario para convertir POST de Fiserv a GET para Shopify
// Este código recibe la respuesta de Fiserv y redirige al cliente

export default function handler(req, res) {
  // Solo permitir método POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  try {
    // Extraer todos los datos que envía Fiserv
    const {
      approval_code,
      oid,
      refnumber,
      status,
      txndate_processed,
      ipgTransactionId,
      chargetotal,
      currency,
      response_hash,
      processor_response_code,
      fail_reason,
      fail_rc,
      ccbrand,
      response_code_3dsecure,
      // ... Fiserv puede enviar más campos, los capturamos todos
      ...otherData
    } = req.body;

    // Determinar si la transacción fue exitosa
    const isSuccess = status === 'APPROVED' || (approval_code && approval_code.startsWith('Y'));

    // URL base de Shopify para redirigir
    const shopifyBaseUrl = isSuccess 
      ? 'https://almapampa.com/pages/payment-success'
      : 'https://almapampa.com/pages/payment-failed';

    // Construir parámetros para GET
    const params = new URLSearchParams({
      approval_code: approval_code || '',
      oid: oid || '',
      status: status || '',
      amount: chargetotal || '',
      transaction_id: ipgTransactionId || '',
      ref: refnumber || '',
      date: txndate_processed || '',
      // Si hay error, incluir detalles
      ...(fail_reason && { error: fail_reason }),
      ...(ccbrand && { brand: ccbrand })
    });

    // URL final de redirección
    const redirectUrl = `${shopifyBaseUrl}?${params.toString()}`;

    // Log para debugging (opcional, útil para ver qué está pasando)
    console.log('Redirigiendo a:', redirectUrl);
    console.log('Datos completos recibidos:', JSON.stringify(req.body, null, 2));

    // Redirigir al cliente con GET (código 302)
    res.redirect(302, redirectUrl);

  } catch (error) {
    console.error('Error procesando la transacción:', error);
    
    // En caso de error, redirigir a página de error con mensaje
    const errorUrl = `https://almapampa.com/pages/payment-failed?error=Error+procesando+pago`;
    res.redirect(302, errorUrl);
  }
}
