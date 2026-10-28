import type { LoginError } from "./login";

// Spanish copy of the sign-in surface (approved prototype). Kept in a `.ts` table, one key per string, so that
// Task 11 moves it to the `auth` namespace of packages/i18n (es-419 + en) without touching the components.

export const authCopy = {
  brand: "ERP-IA",
  login: {
    email: "Correo",
    password: "Contraseña",
    showPassword: "Mostrar contraseña",
    hidePassword: "Ocultar contraseña",
    remember: "Recordarme en este dispositivo por 30 días",
    submit: "Entrar",
    submitting: "Entrando…",
  },
  verify: {
    title: "Verificación en dos pasos",
    hint: "Ingresa el código de 6 dígitos de tu app de autenticación.",
    submit: "Verificar",
    submitting: "Verificando…",
    back: "Volver",
    digit: (n: number) => `Dígito ${n}`,
  },
  enroll: {
    title: "Activa la verificación en dos pasos",
    hint: "Tu rol exige un segundo paso. Escanea el código QR con tu app de autenticación (Google Authenticator, Authy, 1Password) o escribe la clave.",
    qrAlt: "Código QR para tu app de autenticación",
    secretLabel: "Clave",
    codeHint: "Ingresa el primer código de 6 dígitos que muestra la app.",
    preparing: "Preparando el código…",
  },
  home: { title: "Inicio", signOut: "Salir" },
  errors: {
    invalid_credentials: "Correo o contraseña incorrectos.",
    no_company: "Tu usuario no pertenece a ninguna empresa. Pide acceso al administrador.",
    invalid_code: "El código no es correcto. Revisa tu app e inténtalo de nuevo.",
    no_session: "Tu sesión terminó. Ingresa de nuevo.",
    no_factor: "No tienes un segundo paso activado.",
    mfa_required: "Primero verifica tu segundo paso para cambiarlo.",
    unavailable: "No pudimos conectar con el servicio de acceso. Inténtalo de nuevo.",
  } satisfies Record<LoginError, string>,
} as const;
