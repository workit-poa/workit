"use client";

import { useState } from "react";
import { useFormik } from "formik";
import * as yup from "yup";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

type AuthMode = "login" | "signup";
type OAuthProvider = "google" | "facebook" | "twitter";

type SessionState = {
  accessToken?: string;
  user?: {
    id: string;
    email: string | null;
    createdAt: string;
  };
};

const loginSchema = yup.object({
  email: yup.string().trim().email("Enter a valid email address.").required("Email is required."),
  password: yup.string().min(10, "Password must be at least 10 characters.").required("Password is required.")
});

const signupSchema = yup.object({
  email: yup.string().trim().email("Enter a valid email address.").required("Email is required."),
  password: yup
    .string()
    .min(10, "Password must be at least 10 characters.")
    .matches(/[A-Z]/, "Include at least one uppercase letter.")
    .matches(/[a-z]/, "Include at least one lowercase letter.")
    .matches(/[0-9]/, "Include at least one number.")
    .matches(/[^A-Za-z0-9]/, "Include at least one symbol.")
    .required("Password is required."),
  confirmPassword: yup
    .string()
    .required("Confirm your password.")
    .oneOf([yup.ref("password")], "Passwords do not match.")
});

const oauthSchema = yup.object({
  provider: yup.mixed<OAuthProvider>().oneOf(["google", "facebook", "twitter"]).required(),
  email: yup.string().trim().email("Enter a valid email address.").when("provider", {
    is: (value: OAuthProvider) => value !== "google",
    then: schema => schema.required("Email is required for this provider."),
    otherwise: schema => schema.notRequired()
  }),
  providerUserId: yup.string().when("provider", {
    is: (value: OAuthProvider) => value !== "google",
    then: schema => schema.required("Provider user ID is required."),
    otherwise: schema => schema.notRequired()
  }),
  idToken: yup.string().when("provider", {
    is: "google",
    then: schema => schema.required("Google ID token is required."),
    otherwise: schema => schema.notRequired()
  })
});

export function LoginForm() {
  const [mode, setMode] = useState<AuthMode>("login");
  const [provider, setProvider] = useState<OAuthProvider>("google");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);

  async function finishAuth(accessToken: string) {
    const meRes = await fetch("/api/auth/me", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const mePayload = (await meRes.json()) as Record<string, unknown>;
    if (!meRes.ok) {
      throw new Error((mePayload.error as string) || "Could not fetch active user.");
    }

    setSession({
      accessToken,
      user: mePayload.user as SessionState["user"]
    });
  }

  const loginFormik = useFormik({
    initialValues: { email: "", password: "" },
    validationSchema: loginSchema,
    onSubmit: async values => {
      setError(null);
      setStatus(null);
      try {
        const loginRes = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values)
        });
        const loginPayload = (await loginRes.json()) as Record<string, unknown>;
        if (!loginRes.ok) throw new Error((loginPayload.error as string) || "Login failed.");

        const accessToken = String(loginPayload.accessToken || "");
        await finishAuth(accessToken);
        setStatus("Signed in successfully. Your refresh token cookie is active.");
      } catch (submissionError) {
        setError(submissionError instanceof Error ? submissionError.message : "Unexpected error during login.");
      }
    }
  });

  const signupFormik = useFormik({
    initialValues: { email: "", password: "", confirmPassword: "" },
    validationSchema: signupSchema,
    onSubmit: async values => {
      setError(null);
      setStatus(null);
      try {
        const signupRes = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: values.email, password: values.password })
        });
        const signupPayload = (await signupRes.json()) as Record<string, unknown>;
        if (!signupRes.ok) throw new Error((signupPayload.error as string) || "Signup failed.");

        const accessToken = String(signupPayload.accessToken || "");
        await finishAuth(accessToken);
        setStatus("Account created and signed in.");
      } catch (submissionError) {
        setError(submissionError instanceof Error ? submissionError.message : "Unexpected error during signup.");
      }
    }
  });

  const oauthFormik = useFormik({
    initialValues: {
      provider: "google" as OAuthProvider,
      email: "",
      providerUserId: "",
      idToken: ""
    },
    validationSchema: oauthSchema,
    onSubmit: async values => {
      setError(null);
      setStatus(null);
      try {
        const oauthRes = await fetch(`/api/auth/oauth/${values.provider}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: values.email || undefined,
            providerUserId: values.providerUserId || undefined,
            idToken: values.idToken || undefined
          })
        });
        const oauthPayload = (await oauthRes.json()) as Record<string, unknown>;
        if (!oauthRes.ok) throw new Error((oauthPayload.error as string) || "OAuth sign-in failed.");

        const accessToken = String(oauthPayload.accessToken || "");
        await finishAuth(accessToken);
        setStatus(`Signed in with ${values.provider}.`);
      } catch (submissionError) {
        setError(submissionError instanceof Error ? submissionError.message : "Unexpected OAuth error.");
      }
    }
  });

  async function verifyProtectedRoute() {
    if (!session?.accessToken) return;
    setStatus("Checking protected route access...");
    setError(null);

    const response = await fetch("/api/protected/profile", {
      headers: { Authorization: `Bearer ${session.accessToken}` }
    });

    if (!response.ok) {
      const payload = (await response.json()) as Record<string, unknown>;
      setError((payload.error as string) || "Protected route denied.");
      return;
    }

    setStatus("Protected route access confirmed.");
  }

  async function handlePasswordAuthSubmit() {
    if (mode === "login") {
      await loginFormik.submitForm();
    } else {
      await signupFormik.submitForm();
    }
  }

  const activeFormik = mode === "login" ? loginFormik : signupFormik;

  return (
    <Card className="mx-auto w-full max-w-lg">
      <CardHeader>
        <CardTitle>Authentication</CardTitle>
        <CardDescription>
          Sign in, create an account, or use OAuth providers. All flows connect to the same internal user identity.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div role="tablist" aria-label="Authentication mode" className="grid grid-cols-2 gap-2 rounded-md bg-muted p-1">
          <Button
            type="button"
            role="tab"
            aria-selected={mode === "login"}
            aria-controls="login-panel"
            id="login-tab"
            variant={mode === "login" ? "default" : "ghost"}
            onClick={() => setMode("login")}
          >
            Login
          </Button>
          <Button
            type="button"
            role="tab"
            aria-selected={mode === "signup"}
            aria-controls="signup-panel"
            id="signup-tab"
            variant={mode === "signup" ? "default" : "ghost"}
            onClick={() => setMode("signup")}
          >
            Sign up
          </Button>
        </div>

        <form
          className="space-y-4"
          onSubmit={event => {
            event.preventDefault();
            void handlePasswordAuthSubmit();
          }}
          noValidate
          role="tabpanel"
          id={mode === "login" ? "login-panel" : "signup-panel"}
          aria-labelledby={mode === "login" ? "login-tab" : "signup-tab"}
        >
          <div className="space-y-2">
            <Label htmlFor={`${mode}-email`}>Email</Label>
            <Input
              id={`${mode}-email`}
              name="email"
              type="email"
              autoComplete="email"
              value={activeFormik.values.email}
              onChange={activeFormik.handleChange}
              onBlur={activeFormik.handleBlur}
              aria-invalid={Boolean(activeFormik.touched.email && activeFormik.errors.email)}
              aria-describedby={activeFormik.errors.email ? `${mode}-email-error` : undefined}
            />
            {activeFormik.touched.email && activeFormik.errors.email ? (
              <p id={`${mode}-email-error`} className="text-sm text-destructive">
                {activeFormik.errors.email}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor={`${mode}-password`}>Password</Label>
            <div className="relative">
              <Input
                id={`${mode}-password`}
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                value={activeFormik.values.password}
                onChange={activeFormik.handleChange}
                onBlur={activeFormik.handleBlur}
                aria-invalid={Boolean(activeFormik.touched.password && activeFormik.errors.password)}
                aria-describedby={activeFormik.errors.password ? `${mode}-password-error` : `${mode}-password-help`}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1 h-8 w-8"
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                onClick={() => setShowPassword(value => !value)}
              >
                {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
              </Button>
            </div>
            <p id={`${mode}-password-help`} className="text-sm text-muted-foreground">
              Minimum 10 characters.
            </p>
            {activeFormik.touched.password && activeFormik.errors.password ? (
              <p id={`${mode}-password-error`} className="text-sm text-destructive">
                {activeFormik.errors.password}
              </p>
            ) : null}
          </div>

          {mode === "signup" ? (
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirm password</Label>
              <Input
                id="confirmPassword"
                name="confirmPassword"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                value={signupFormik.values.confirmPassword}
                onChange={signupFormik.handleChange}
                onBlur={signupFormik.handleBlur}
                aria-invalid={Boolean(signupFormik.touched.confirmPassword && signupFormik.errors.confirmPassword)}
                aria-describedby={signupFormik.errors.confirmPassword ? "signup-confirm-error" : undefined}
              />
              {signupFormik.touched.confirmPassword && signupFormik.errors.confirmPassword ? (
                <p id="signup-confirm-error" className="text-sm text-destructive">
                  {signupFormik.errors.confirmPassword}
                </p>
              ) : null}
            </div>
          ) : null}

          <Button
            type="submit"
            className="w-full"
            disabled={activeFormik.isSubmitting || !activeFormik.isValid || !activeFormik.dirty}
            aria-busy={activeFormik.isSubmitting}
          >
            {activeFormik.isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {mode === "login" ? "Sign in with email" : "Create account"}
          </Button>
        </form>

        <section className="space-y-3 rounded-lg border border-border bg-muted/40 p-4" aria-label="OAuth sign in">
          <h3 className="text-sm font-semibold">OAuth providers</h3>
          <p className="text-xs text-muted-foreground">
            Google uses `idToken`. Facebook and X (Twitter) use provider user ID + email in trusted profile mode.
          </p>
          <form
            className="space-y-3"
            onSubmit={event => {
              event.preventDefault();
              void oauthFormik.submitForm();
            }}
            noValidate
          >
            <div className="space-y-2">
              <Label htmlFor="provider">Provider</Label>
              <select
                id="provider"
                name="provider"
                className="focus-ring h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={provider}
                onChange={event => {
                  const next = event.target.value as OAuthProvider;
                  setProvider(next);
                  void oauthFormik.setFieldValue("provider", next);
                }}
              >
                <option value="google">Google</option>
                <option value="facebook">Facebook</option>
                <option value="twitter">X (Twitter)</option>
              </select>
            </div>

            {provider === "google" ? (
              <div className="space-y-2">
                <Label htmlFor="idToken">Google ID token</Label>
                <Input
                  id="idToken"
                  name="idToken"
                  value={oauthFormik.values.idToken}
                  onChange={oauthFormik.handleChange}
                  onBlur={oauthFormik.handleBlur}
                  aria-invalid={Boolean(oauthFormik.touched.idToken && oauthFormik.errors.idToken)}
                  aria-describedby={oauthFormik.errors.idToken ? "oauth-id-token-error" : undefined}
                />
                {oauthFormik.touched.idToken && oauthFormik.errors.idToken ? (
                  <p id="oauth-id-token-error" className="text-sm text-destructive">
                    {oauthFormik.errors.idToken}
                  </p>
                ) : null}
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="providerUserId">Provider user ID</Label>
                  <Input
                    id="providerUserId"
                    name="providerUserId"
                    value={oauthFormik.values.providerUserId}
                    onChange={oauthFormik.handleChange}
                    onBlur={oauthFormik.handleBlur}
                    aria-invalid={Boolean(oauthFormik.touched.providerUserId && oauthFormik.errors.providerUserId)}
                    aria-describedby={oauthFormik.errors.providerUserId ? "oauth-provider-id-error" : undefined}
                  />
                  {oauthFormik.touched.providerUserId && oauthFormik.errors.providerUserId ? (
                    <p id="oauth-provider-id-error" className="text-sm text-destructive">
                      {oauthFormik.errors.providerUserId}
                    </p>
                  ) : null}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="oauthEmail">Email</Label>
                  <Input
                    id="oauthEmail"
                    name="email"
                    type="email"
                    value={oauthFormik.values.email}
                    onChange={oauthFormik.handleChange}
                    onBlur={oauthFormik.handleBlur}
                    aria-invalid={Boolean(oauthFormik.touched.email && oauthFormik.errors.email)}
                    aria-describedby={oauthFormik.errors.email ? "oauth-email-error" : undefined}
                  />
                  {oauthFormik.touched.email && oauthFormik.errors.email ? (
                    <p id="oauth-email-error" className="text-sm text-destructive">
                      {oauthFormik.errors.email}
                    </p>
                  ) : null}
                </div>
              </>
            )}

            <Button type="submit" variant="secondary" className="w-full" disabled={oauthFormik.isSubmitting}>
              {oauthFormik.isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Continue with {provider === "twitter" ? "X" : provider.charAt(0).toUpperCase() + provider.slice(1)}
            </Button>
          </form>
        </section>

        <div aria-live="polite" aria-atomic="true">
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertTitle>Authentication failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {status ? (
            <Alert className="mt-3">
              <AlertTitle>Status</AlertTitle>
              <AlertDescription>{status}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        {session?.user ? (
          <section className="space-y-3 rounded-lg border border-border bg-muted/40 p-3" aria-label="Session details">
            <p className="text-sm">
              <strong>User ID:</strong> {session.user.id}
            </p>
            <p className="text-sm">
              <strong>Email:</strong> {session.user.email || "Not available"}
            </p>
            <Button variant="outline" className="w-full" onClick={() => void verifyProtectedRoute()}>
              Verify protected route
            </Button>
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}
