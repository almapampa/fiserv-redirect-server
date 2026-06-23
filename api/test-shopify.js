// api/test-shopify.js
// =====================================================================
// ARCHIVO TEMPORAL DE PRUEBA
// Sirve solo para confirmar que Vercel puede pedirle un token a Shopify
// y hacer una consulta. Una vez que veas "ok": true, se puede BORRAR.
// No toca nada de la tienda, solo lee.
// =====================================================================

const SHOP = process.env.SHOPIFY_STORE_DOMAIN;      // ej: almapampa.myshopify.com
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = "2026-04";

export default async function handler(req, res) {
  try {
    // 0) Chequear que las variables estén cargadas
    if (!SHOP || !CLIENT_ID || !CLIENT_SECRET) {
      return res.status(500).json({
        ok: false,
        paso: "variables",
        error:
          "Faltan variables de entorno. Revisá SHOPIFY_STORE_DOMAIN, " +
          "SHOPIFY_CLIENT_ID y SHOPIFY_CLIENT_SECRET en Vercel (y hacé redeploy).",
      });
    }

    // 1) Pedir el token a Shopify (client credentials grant)
    const tokenResp = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    });

    const tokenData = await tokenResp.json();

    if (!tokenResp.ok || !tokenData.access_token) {
      return res.status(500).json({
        ok: false,
        paso: "token",
        status: tokenResp.status,
        error: tokenData,
        ayuda:
          "Si ves 'shop_not_permitted', la tienda no está en la misma " +
          "organización que la app. Copiá este error y mandáselo a Claude.",
      });
    }

    const token = tokenData.access_token;

    // 2) Consulta mínima para confirmar el acceso (nombre de la tienda + 1 producto)
    const gqlResp = await fetch(
      `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({
          query:
            "{ shop { name myshopifyDomain } products(first: 1) { edges { node { title } } } }",
        }),
      }
    );

    const gqlData = await gqlResp.json();

    if (gqlData.errors) {
      return res.status(500).json({
        ok: false,
        paso: "consulta",
        error: gqlData.errors,
      });
    }

    // 3) Todo bien
    return res.status(200).json({
      ok: true,
      mensaje: "¡Funciona! Vercel puede hablar con Shopify.",
      scopes_otorgados: tokenData.scope,
      token_expira_en_segundos: tokenData.expires_in,
      tienda: gqlData.data.shop,
      primer_producto:
        gqlData.data.products.edges[0]?.node?.title ?? "(no hay productos)",
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      paso: "excepcion",
      error: String(err),
    });
  }
}
