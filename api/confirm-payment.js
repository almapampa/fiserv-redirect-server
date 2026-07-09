import { Resend } from 'resend';
import { google } from 'googleapis';
import crypto from 'crypto';

const resend = new Resend(process.env.RESEND_API_KEY);
const STORE_EMAIL = 'almapampamendoza@gmail.com';

// ── SHOPIFY ──────────────────────────────────────────────────────
const SHOP = process.env.SHOPIFY_STORE_DOMAIN;          // mu4ph1-kv.myshopify.com
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_API_VERSION = '2026-04';

// ── META CONVERSIONS API ─────────────────────────────────────────
const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_CAPI_TOKEN = process.env.META_CAPI_TOKEN;
const META_API_VERSION = 'v21.0';
// Opcional: si querés ver los eventos en "Probar eventos" del Events Manager,
// creá la variable META_TEST_EVENT_CODE en Vercel. Borrala cuando termines de probar.
const META_TEST_EVENT_CODE = process.env.META_TEST_EVENT_CODE || '';

// Códigos de país → nombre que Shopify entiende en la dirección de envío
const COUNTRY_NAMES = { AR: 'Argentina', CL: 'Chile', US: 'United States' };

function getGoogleAuth() {
  const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  return new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getShopifyToken() {
  const resp = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
    }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error('No se pudo obtener token de Shopify: ' + JSON.stringify(data));
  }
  return data.access_token;
}

// Busca la fila del pedido por OID (columna P, índice 15). Devuelve { fila, datos } o null.
async function buscarFilaPedido(oid) {
  if (!oid) return null;
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Sheet1!A:Y',
  });

  const rows = response.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][15] === oid) {
      return { fila: i + 1, datos: rows[i] }; // Sheets es base 1
    }
  }
  return null;
}

// Marca el estado en PAGO_CONFIRMADO (columna O) y, si hay orden, la guarda en columna V.
async function actualizarSheets(fila, ordenShopify) {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `Sheet1!O${fila}`,
    valueInputOption: 'RAW',
    resource: { values: [['PAGO_CONFIRMADO']] },
  });

  if (ordenShopify) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `Sheet1!V${fila}`,
      valueInputOption: 'RAW',
      resource: { values: [[ordenShopify]] },
    });
  }
}

// Crea la orden en Shopify a partir de los datos de la fila. Descuenta stock.
async function crearOrdenShopify(datos) {
  // Columna U (índice 20) = lista de productos [{ variant_id, quantity }]
  let items;
  try { items = JSON.parse(datos[20] || '[]'); } catch (e) { items = []; }
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, motivo: 'sin_items' };
  }

  const lineItems = items.map(function (it) {
    return {
      variantId: 'gid://shopify/ProductVariant/' + it.variant_id,
      quantity: it.quantity,
    };
  });

  // Shopify exige nombre Y apellido en la dirección, sino la ignora
  const nombreCompleto = (datos[1] || '').trim();
  const partes = nombreCompleto.split(' ');
  const firstName = partes.shift() || nombreCompleto || '.';
  const lastName = partes.join(' ') || '.';

  const order = {
    email: datos[2] || undefined,                 // columna C
    financialStatus: 'PAID',
    lineItems: lineItems,
    tags: ['alma-pampa-web'],
    note: 'Pedido web Alma Pampa | OID: ' + (datos[15] || '') +
          ' | Monto cobrado: ' + (datos[19] || datos[10] || '') +
          ' | Productos: ' + (datos[16] || ''),
    shippingAddress: {
      firstName: firstName,
      lastName: lastName,
      address1: datos[4] || '',                   // columna E
      address2: datos[5] || '',                   // columna F (depto)
      city: datos[6] || '',                       // columna G
      province: datos[7] || '',                   // columna H
      zip: datos[8] || '',                        // columna I
      country: COUNTRY_NAMES[datos[9]] || datos[9] || '',
      phone: datos[3] || '',                      // columna D
    },
  };

  const mutation = `
    mutation ordenCrear($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
      orderCreate(order: $order, options: $options) {
        order { id name }
        userErrors { field message }
      }
    }`;

  const variables = {
    order: order,
    options: {
      inventoryBehaviour: 'DECREMENT_IGNORING_POLICY', // descontar stock siempre
      sendReceipt: false,            // no mandar email de Shopify (ya mandamos el nuestro)
      sendFulfillmentReceipt: false,
    },
  };

  const token = await getShopifyToken();
  const resp = await fetch(`https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query: mutation, variables: variables }),
  });

  const data = await resp.json();

  if (data.errors) {
    return { ok: false, motivo: JSON.stringify(data.errors) };
  }
  const result = data.data && data.data.orderCreate;
  if (result && result.userErrors && result.userErrors.length > 0) {
    return { ok: false, motivo: JSON.stringify(result.userErrors) };
  }
  if (result && result.order) {
    return { ok: true, nombre: result.order.name };
  }
  return { ok: false, motivo: 'respuesta_inesperada' };
}

// ── META: helpers de normalización y hasheo ──────────────────────
// Meta exige los datos del cliente en SHA-256, normalizados antes de hashear.
function sha256(valor) {
  if (!valor) return undefined;
  return crypto.createHash('sha256').update(String(valor)).digest('hex');
}

// minúsculas + sin espacios al borde (regla general de Meta)
function normalizar(texto) {
  if (!texto) return '';
  return String(texto).trim().toLowerCase();
}

// Teléfono: solo dígitos, con código de país, sin '+' ni espacios.
// "+54 2615635082" → "542615635082"
function normalizarTelefono(tel) {
  if (!tel) return '';
  return String(tel).replace(/\D/g, '');
}

// Extrae el número de un monto que puede venir formateado ("$ 315.000" → 315000).
// CLP y ARS no usan decimales en estos checkouts, así que quitar todo lo que
// no sea dígito es seguro.
function parseMonto(valor) {
  if (valor === undefined || valor === null) return 0;
  const soloDigitos = String(valor).replace(/\D/g, '');
  return soloDigitos ? parseInt(soloDigitos, 10) : 0;
}

// ── META: enviar el evento Purchase ──────────────────────────────
// Se llama SOLO cuando la orden se creó con éxito en Shopify.
// Nunca lanza excepciones: si falla, loguea y sigue.
async function enviarPurchaseMeta(datos) {
  try {
    if (!META_PIXEL_ID || !META_CAPI_TOKEN) {
      console.error('Meta CAPI: faltan META_PIXEL_ID o META_CAPI_TOKEN en Vercel.');
      return;
    }

    // Moneda real cobrada (columna S). Si no está, asumimos ARS.
    const currency = (datos[18] || 'ARS').toUpperCase();

    // Monto REAL cobrado, nunca el precio de lista:
    //  - ARS  → columna K (número limpio, ya con el descuento aplicado)
    //  - otra → columna T (displayTotal, texto formateado en la moneda real)
    const value = currency === 'ARS'
      ? parseMonto(datos[10])
      : parseMonto(datos[19]) || parseMonto(datos[10]);

    if (!value) {
      console.error('Meta CAPI: monto en 0, no se envía el evento. OID:', datos[15]);
      return;
    }

    // event_id (columna Y). Si el pedido es viejo y no lo tiene,
    // usamos el OID: sigue siendo estable y único por pedido.
    const eventId = (datos[24] || '').trim() || ('oid-' + (datos[15] || ''));

    // Nombre completo (columna B) → nombre y apellido por separado
    const nombreCompleto = (datos[1] || '').trim();
    const partes = nombreCompleto.split(' ');
    const firstName = partes.shift() || '';
    const lastName = partes.join(' ') || '';

    // Datos de matching, todos hasheados. undefined = campo omitido.
    const userData = {
      em: sha256(normalizar(datos[2])),                    // email (C)
      ph: sha256(normalizarTelefono(datos[3])),            // teléfono (D)
      fn: sha256(normalizar(firstName)),                   // nombre
      ln: sha256(normalizar(lastName)),                    // apellido
      ct: sha256(normalizar(datos[6]).replace(/\s/g, '')), // ciudad (G), sin espacios
      st: sha256(normalizar(datos[7])),                    // provincia (H)
      zp: sha256(normalizar(datos[8])),                    // código postal (I)
      country: sha256(normalizar(datos[9])),               // país (J), ej: "ar"
      external_id: sha256(normalizar(datos[15])),          // OID (P)
    };

    // Cookies del navegador (columnas W y X). Solo se mandan si existen.
    const fbp = (datos[22] || '').trim();
    const fbc = (datos[23] || '').trim();
    if (fbp) userData.fbp = fbp;
    if (fbc) userData.fbc = fbc;

    // Limpiar campos vacíos (Meta rechaza valores undefined)
    Object.keys(userData).forEach(function (k) {
      if (!userData[k]) delete userData[k];
    });

    const payload = {
      data: [{
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,                    // deduplicación con el navegador
        action_source: 'website',
        event_source_url: 'https://almapampa.com/pages/pagar',
        user_data: userData,
        custom_data: {
          currency: currency,
          value: value,
          order_id: datos[15] || '',
        },
      }],
    };

    if (META_TEST_EVENT_CODE) {
      payload.test_event_code = META_TEST_EVENT_CODE;
    }

    const url = 'https://graph.facebook.com/' + META_API_VERSION + '/' +
                META_PIXEL_ID + '/events?access_token=' +
                encodeURIComponent(META_CAPI_TOKEN);

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const respuesta = await resp.json();

    if (!resp.ok || respuesta.error) {
      console.error('Meta CAPI: error al enviar Purchase:', JSON.stringify(respuesta));
    } else {
      console.log('Meta CAPI: Purchase enviado. OID:', datos[15],
                  '| value:', value, currency,
                  '| event_id:', eventId,
                  '| recibidos:', respuesta.events_received);
    }
  } catch (metaError) {
    // Nunca cortamos el flujo: el email al cliente se manda igual
    console.error('Meta CAPI: excepción al enviar Purchase:', metaError);
  }
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

  // Resultado de la creación de orden (se muestra en el HTML final)
  let ordenInfo = { creada: false };

  try {
    // ── CREAR ORDEN EN SHOPIFY + ACTUALIZAR ESTADO EN SHEETS ─────
    try {
      const pedido = await buscarFilaPedido(oid);
      if (!pedido) {
        console.warn('confirm-payment: OID no encontrado en Sheets:', oid);
      } else if ((pedido.datos[21] || '').trim() !== '') {
        // Columna V ya tiene una orden → no duplicar (protege ante doble clic)
        ordenInfo = { yaExistia: true, nombre: pedido.datos[21] };
        await actualizarSheets(pedido.fila, null);
      } else {
        const resultado = await crearOrdenShopify(pedido.datos);
        if (resultado.ok) {
          ordenInfo = { creada: true, nombre: resultado.nombre };
          await actualizarSheets(pedido.fila, resultado.nombre);
          await enviarPurchaseMeta(pedido.datos);
        } else {
          ordenInfo = { creada: false, motivo: resultado.motivo };
          await actualizarSheets(pedido.fila, null);
          console.error('confirm-payment: no se pudo crear orden Shopify:', resultado.motivo);
        }
      }
    } catch (shopifyError) {
      // Nunca cortamos el flujo: el email al cliente se manda igual
      console.error('Error creando orden / actualizando Sheets:', shopifyError);
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
    ${ordenInfo.creada
      ? `<p style="font-size:13px;color:#27ae60;margin-top:6px;">✔ Orden ${ordenInfo.nombre} creada en Shopify (stock descontado).</p>`
      : ordenInfo.yaExistia
      ? `<p style="font-size:13px;color:#888;margin-top:6px;">ℹ La orden ${ordenInfo.nombre} ya estaba creada (no se duplicó).</p>`
      : ordenInfo.motivo === 'sin_items'
      ? `<p style="font-size:13px;color:#e67e22;margin-top:6px;">⚠ No se creó orden en Shopify: este pedido no tiene IDs de productos (p. ej. checkout de Chile, todavía pendiente).</p>`
      : `<p style="font-size:13px;color:#e67e22;margin-top:6px;">⚠ No se pudo crear la orden en Shopify automáticamente. Revisá el panel.</p>`}
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
