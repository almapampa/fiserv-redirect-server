// ─────────────────────────────────────────────────────────────────
// Lógica compartida de confirmación de ventas.
// La usan confirm-payment.js (pagos manuales) y fiserv-redirect.js (tarjeta).
// Ambos hacen lo mismo: crear la orden en Shopify, actualizar la planilla
// y enviar el Purchase a Meta. Solo cambia el texto del estado.
// ─────────────────────────────────────────────────────────────────
import { google } from 'googleapis';
import crypto from 'crypto';

// ── SHOPIFY ──────────────────────────────────────────────────────
const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_API_VERSION = '2026-04';
const COUNTRY_NAMES = { AR: 'Argentina', CL: 'Chile', US: 'United States' };

// ── META CONVERSIONS API ─────────────────────────────────────────
const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_CAPI_TOKEN = process.env.META_CAPI_TOKEN;
const META_API_VERSION = 'v21.0';
const META_TEST_EVENT_CODE = process.env.META_TEST_EVENT_CODE || '';

// ── GOOGLE SHEETS ────────────────────────────────────────────────
function getGoogleAuth() {
  const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  return new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

// Busca la fila del pedido por OID (columna P, índice 15).
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

// Escribe el estado en la columna O.
async function actualizarEstado(fila, estado) {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `Sheet1!O${fila}`,
    valueInputOption: 'RAW',
    resource: { values: [[estado]] },
  });
}

// Escribe el nº de orden de Shopify en la columna V.
async function escribirOrdenEnSheets(fila, nombreOrden) {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `Sheet1!V${fila}`,
    valueInputOption: 'RAW',
    resource: { values: [[nombreOrden]] },
  });
}

// ── CREAR ORDEN EN SHOPIFY (descuenta stock) ─────────────────────
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

async function crearOrdenShopify(datos) {
  // Columna U (índice 20) = [{ variant_id, quantity }]
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
    email: datos[2] || undefined,
    financialStatus: 'PAID',
    lineItems: lineItems,
    tags: ['alma-pampa-web'],
    note: 'Pedido web Alma Pampa | OID: ' + (datos[15] || '') +
          ' | Monto cobrado: ' + (datos[12] || datos[10] || '') +
          ' | Productos: ' + (datos[16] || ''),
    shippingAddress: {
      firstName: firstName,
      lastName: lastName,
      address1: datos[4] || '',
      address2: datos[5] || '',
      city: datos[6] || '',
      province: datos[7] || '',
      zip: datos[8] || '',
      country: COUNTRY_NAMES[datos[9]] || datos[9] || '',
      phone: datos[3] || '',
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
      inventoryBehaviour: 'DECREMENT_IGNORING_POLICY',
      sendReceipt: false,
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

// ── META: normalización y hasheo ─────────────────────────────────
function sha256(valor) {
  if (!valor) return undefined;
  return crypto.createHash('sha256').update(String(valor)).digest('hex');
}

function normalizar(texto) {
  if (!texto) return '';
  return String(texto).trim().toLowerCase();
}

// "+54 2615635082" → "542615635082"
function normalizarTelefono(tel) {
  if (!tel) return '';
  return String(tel).replace(/\D/g, '');
}

// "$ 315.000" o "315000.00" → 315000
function parseMonto(valor) {
  if (valor === undefined || valor === null) return 0;
  const entero = String(valor).split(/[.,]/)[0];
  const soloDigitos = entero.replace(/\D/g, '');
  return soloDigitos ? parseInt(soloDigitos, 10) : 0;
}

// ── META: enviar el evento Purchase ──────────────────────────────
// Nunca lanza excepciones: si falla, loguea y sigue.
async function enviarPurchaseMeta(datos) {
  try {
    if (!META_PIXEL_ID || !META_CAPI_TOKEN) {
      console.error('Meta CAPI: faltan META_PIXEL_ID o META_CAPI_TOKEN en Vercel.');
      return;
    }

    // Todo lo que reportamos a Meta va en ARS (Fiserv y transferencias
    // guardan el monto real en ARS en la columna M).
    const currency = 'ARS';

    // Monto REAL cobrado (columna M, índice 12). La K es respaldo
    // solo para filas viejas que no tuvieran M.
    const value = parseMonto(datos[12]) || parseMonto(datos[10]);

    if (!value) {
      console.error('Meta CAPI: monto en 0, no se envía el evento. OID:', datos[15]);
      return;
    }

    // event_id (columna Y). Si el pedido es viejo y no lo tiene, usamos el OID.
    const eventId = (datos[24] || '').trim() || ('oid-' + (datos[15] || ''));

    const nombreCompleto = (datos[1] || '').trim();
    const partes = nombreCompleto.split(' ');
    const firstName = partes.shift() || '';
    const lastName = partes.join(' ') || '';

    const userData = {
      em: sha256(normalizar(datos[2])),
      ph: sha256(normalizarTelefono(datos[3])),
      fn: sha256(normalizar(firstName)),
      ln: sha256(normalizar(lastName)),
      ct: sha256(normalizar(datos[6]).replace(/\s/g, '')),
      st: sha256(normalizar(datos[7])),
      zp: sha256(normalizar(datos[8])),
      country: sha256(normalizar(datos[9])),
      external_id: sha256(normalizar(datos[15])),
    };

    const fbp = (datos[22] || '').trim();
    const fbc = (datos[23] || '').trim();
    if (fbp) userData.fbp = fbp;
    if (fbc) userData.fbc = fbc;

    Object.keys(userData).forEach(function (k) {
      if (!userData[k]) delete userData[k];
    });

    const payload = {
      data: [{
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
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
    console.error('Meta CAPI: excepción al enviar Purchase:', metaError);
  }
}

// ─────────────────────────────────────────────────────────────────
// FUNCIÓN PRINCIPAL — confirma una venta de punta a punta.
//
//   oid         → nº de pedido interno (columna P)
//   estadoFinal → texto para la columna O
//                 ('PAGO_CONFIRMADO' manual · 'APROBADO' tarjeta)
//
// Devuelve: { creada, nombre } | { yaExistia, nombre } | { creada:false, motivo }
// ─────────────────────────────────────────────────────────────────
export async function procesarVentaConfirmada(oid, estadoFinal) {
  const pedido = await buscarFilaPedido(oid);

  if (!pedido) {
    console.warn('procesarVentaConfirmada: OID no encontrado en Sheets:', oid);
    return { creada: false, motivo: 'oid_no_encontrado' };
  }

  // IDEMPOTENCIA: si la columna V ya tiene orden, no repetimos nada
  // (ni orden en Shopify, ni Purchase a Meta).
  const ordenExistente = (pedido.datos[21] || '').trim();
  if (ordenExistente !== '') {
    await actualizarEstado(pedido.fila, estadoFinal);
    return { yaExistia: true, nombre: ordenExistente };
  }

  const resultado = await crearOrdenShopify(pedido.datos);

  if (!resultado.ok) {
    await actualizarEstado(pedido.fila, estadoFinal);
    console.error('procesarVentaConfirmada: no se pudo crear orden Shopify:', resultado.motivo);
    return { creada: false, motivo: resultado.motivo };
  }

  await actualizarEstado(pedido.fila, estadoFinal);
  await escribirOrdenEnSheets(pedido.fila, resultado.nombre);
  await enviarPurchaseMeta(pedido.datos);

  return { creada: true, nombre: resultado.nombre };
}
