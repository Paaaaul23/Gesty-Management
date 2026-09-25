# Gesty Management

Gestión para pequeños comercios. Entorno local.

- **Panel de administrador** (`/admin`): alta, edición, suspensión y baja de clientes; ver sus locales, empleados y documentos; abrir el panel de cualquier cliente.
- **Panel de cliente** (`/app`): resumen, captura inteligente, documentos (facturas, albaranes, pedidos), precisión del reconocimiento, locales y empleados, configuración.

## Arrancar

Requiere Node.js 22.13 o superior (usa `node:sqlite`, no hace falta instalar ninguna base de datos).

```
npm install
npm run seed     # crea admin, cliente Torca 3D, local Torca 3D y empleado Javier González
npm start        # http://localhost:3000
```

O doble clic en `Iniciar Gesty.bat`.

`npm run seed` imprime las contraseñas generadas la primera vez. Para fijarlas tú:
`ADMIN_PASSWORD=... CLIENT_PASSWORD=... npm run seed` (solo si los usuarios aún no existen).

Los datos se guardan en `data/` (base de datos `gesty.db` y archivos subidos en `data/uploads`). Para empezar de cero, borra la carpeta `data/` y vuelve a ejecutar el seed.

## Reconocimiento de documentos

1. **Texto**: PDF digital → capa de texto (pdfjs). Foto o PDF escaneado → OCR en español (tesseract.js). La primera lectura por OCR descarga el modelo de español (~20 MB) a `data/tessdata`.
2. **Campos**: tipo de documento, proveedor, NIF/CIF, número, fecha, vencimiento, base, tipo y cuota de IVA, total, forma de pago, IBAN y líneas de detalle (`extract.js`).
3. **Comprobaciones**: dígito de control del NIF/CIF (con corrección de errores típicos de OCR, p. ej. `8`→`B`) y cuadre base + IVA = total.
4. **Revisión**: el usuario corrige y valida. La página *Precisión del reconocimiento* compara lo extraído con lo validado, por campo y por documento.
