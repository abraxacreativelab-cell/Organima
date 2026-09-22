# Verificación interfaz
- [ ] G1 Comportamiento y errores de interfaz verificados.
  CHECK: node --import tsx --test test/ui.test.ts && echo UI_OK
  EXPECT: UI_OK
- [ ] G2 JavaScript se analiza sin error de sintaxis.
  CHECK: node --check public/app.js && echo JS_OK
  EXPECT: JS_OK
