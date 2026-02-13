# Servidor Intermediario Fiserv → Shopify

Este servidor convierte las respuestas POST de Fiserv a redirecciones GET compatibles con Shopify.

## ¿Qué hace?

1. Recibe el POST de Fiserv después de procesar un pago
2. Extrae los datos importantes de la transacción
3. Redirige al cliente a Shopify usando método GET (compatible)

## URLs después del deploy

Una vez deployado en Vercel, tu servidor tendrá una URL como:
```
https://tu-proyecto.vercel.app/fiserv-redirect
```

Esta es la URL que deberás usar como `responseSuccessURL` en tu formulario de Fiserv.

## Configuración en Shopify

Modifica tu sección de pago para que apunte a este servidor:

```html
<input type="hidden" name="responseSuccessURL" value="https://TU-PROYECTO.vercel.app/fiserv-redirect">
<input type="hidden" name="responseFailURL" value="https://TU-PROYECTO.vercel.app/fiserv-redirect">
```

## Páginas necesarias en Shopify

Asegúrate de tener estas páginas creadas:
- `/pages/payment-success` - Para pagos exitosos
- `/pages/payment-failed` - Para pagos fallidos

## Soporte

Para cualquier duda, contactar a soporte de Fiserv o revisar la documentación de integración.
