// api/test-shopify.js
// =====================================================================
// ARCHIVO TEMPORAL DE PRUEBA (versión 2)
// Confirma que Vercel puede pedir un token a Shopify y MUESTRA qué
// permisos (scopes) tiene realmente ese token. No toca nada, solo lee.
// Una vez que veas los 3 permisos, se puede BORRAR.
// =====================================================================

const SHOP = process.env.SHOPIFY_STORE_DOMAIN;      // ej: mu4ph1-kv.myshopify.com
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
      });
    }

    const token = tokenData.access_token;

    // 2) Consulta mínima que NO necesita permisos especiales (solo el nombre de la tienda)
    const gqlResp = await fetch(
      `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({
          query: "{ shop { name myshopifyDomain } }",
        }),
      }
    );

    const gqlData = await gqlResp.json();

    // 3) Mostrar SIEMPRE los permisos que tiene el token (esto es lo que nos importa ahora)
    return res.status(200).json({
      ok: true,
      mensaje: "Token obtenido correctamente. Revisá los permisos abajo.",
      permisos_activos: tokenData.scope,
      tiene_write_orders: (tokenData.scope || "").includes("write_orders"),
      tiene_read_orders: (tokenData.scope || "").includes("read_orders"),
      tiene_read_products: (tokenData.scope || "").includes("read_products"),
      token_expira_en_segundos: tokenData.expires_in,
      tienda: gqlData?.data?.shop ?? null,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      paso: "excepcion",
      error: String(err),
    });
  }
}
