// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

import { Alert, AlertDescription } from '@lib/client/components/ui/alert';
import { Button } from '@lib/client/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@lib/client/components/ui/card';
import { Input } from '@lib/client/components/ui/input';
import { Label } from '@lib/client/components/ui/label';
import { type AuthenticationContextProvider, type User } from '@lib/utils/access-types';
import config from '@lib/utils/config';
import { HasuraHeader, HasuraRole } from '@lib/utils/hasura-types';
import { useLogin, useTranslate, type AuthProvider } from '@refinedev/core';
import React, { useEffect, useState } from 'react';
import { getSession, signIn, signOut } from 'next-auth/react';
import { fetchDevRoles, fetchDevToken, isStaleDevSession } from '@lib/utils/dev-client';
import { useQuery } from '@tanstack/react-query';

/**
 * Configuration for the auth provider
 */
export interface GenericAuthProviderConfig {
  tokenKey?: string;
  userKey?: string;
}

/**
 * Default auth provider implementation
 */
const ADMIN_EMAIL = config.adminEmail;
const TENANT_ID = config.tenantId;

export const genericAdminUser: User = {
  id: '1',
  name: 'Admin User',
  email: ADMIN_EMAIL,
  roles: ['admin'],
};

/**
 * Custom Login Page Component using shadcn/ui
 */
const LoginPage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('');
  const { data: devRoles = [] } = useQuery({
    queryKey: ['dev', 'roles'],
    queryFn: config.coreTransport === 'server' ? async () => [] : fetchDevRoles,
    staleTime: Infinity,
    retry: false,
  });

  useEffect(() => {
    if (!role && devRoles.length > 0) {
      setRole(devRoles.includes('admin') ? 'admin' : devRoles[0]);
    }
  }, [devRoles, role]);
  const [error, setError] = useState<string | null>(null);

  const { mutate: login, isPending: isLoading } = useLogin();
  const translate = useTranslate();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    login(
      { email, password, roles: role ? [role] : undefined },
      {
        onError: () => {
          setError(translate('pages.login.invalidCredentials'));
        },
      },
    );
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12 sm:px-6 lg:px-8">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold text-center">
            {translate('pages.login.title')}
          </CardTitle>
          <CardDescription className="text-center">
            {translate('pages.login.description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="email">{translate('pages.login.fields.email')}</Label>
              <Input
                id="email"
                type="email"
                placeholder={translate('pages.login.placeholders.email')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                disabled={isLoading}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">{translate('pages.login.fields.password')}</Label>
              <Input
                id="password"
                type="password"
                placeholder={translate('pages.login.placeholders.password')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                disabled={isLoading}
              />
            </div>

            {devRoles.length > 0 && (
              <div className="space-y-2">
                <Alert>
                  <AlertDescription>{translate('pages.login.localDevNotice')}</AlertDescription>
                </Alert>
                <Label htmlFor="role">{translate('pages.login.fields.role')}</Label>
                <select
                  id="role"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  disabled={isLoading}
                >
                  {devRoles.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? translate('pages.login.signingIn') : translate('pages.login.signin')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};

/**
 * Creates a default permissive auth provider that uses localStorage
 * for persistence and always grants permissions
 */
let sessionChecked = false;

export const createGenericAuthProvider = (
  options: GenericAuthProviderConfig = {},
): AuthProvider & AuthenticationContextProvider => {
  const { tokenKey = 'auth_token', userKey = 'auth_user' } = options;
  /**
   * Save token to storage
   */
  const saveToken = (token: string): void => {
    localStorage.setItem(tokenKey, token);
  };

  /**
   * Get token from storage
   */
  const getToken = async (): Promise<string | undefined> => {
    if (config.coreTransport === 'server') return undefined;
    return localStorage.getItem(tokenKey) || undefined;
  };

  /**
   * Save user to storage
   */
  const saveUser = (user: User): void => {
    localStorage.setItem(userKey, JSON.stringify(user));
  };

  /**
   * Get user from storage
   */
  const getUser = (): User | null => {
    const userStr = localStorage.getItem(userKey);
    if (!userStr) return null;
    try {
      return JSON.parse(userStr) as User;
    } catch (e) {
      return null;
    }
  };

  /**
   * Get permissions
   */
  const getPermissions = async () => {
    if (config.coreTransport === 'server') {
      const session = await getSession();
      return { roles: session?.user?.roles ?? [] };
    }
    const user = getUser();
    return {
      roles: user?.roles || [],
    };
  };

  const getUserRole = async (): Promise<string | undefined> => {
    const roles = (await getPermissions()).roles;
    if (roles && roles.length > 0) {
      if (roles.includes(HasuraRole.ADMIN)) {
        return HasuraRole.ADMIN;
      }
      return HasuraRole.USER;
    }
    return undefined;
  };

  /**
   * Get the Hasura role from the identity
   */
  const getHasuraHeaders = async (): Promise<Map<HasuraHeader, string>> => {
    const hasuraHeaders = new Map<HasuraHeader, string>();

    const roles = (await getPermissions()).roles;
    if (roles && roles.length > 0 && roles.includes(HasuraRole.ADMIN)) {
      hasuraHeaders.set(HasuraHeader.X_HASURA_ROLE, HasuraRole.ADMIN);
    } else {
      hasuraHeaders.set(HasuraHeader.X_HASURA_ROLE, HasuraRole.USER);
    }

    hasuraHeaders.set(HasuraHeader.X_HASURA_TENANT_ID, TENANT_ID);

    return hasuraHeaders;
  };

  // Return the auth provider implementation
  return {
    login: async ({ email, password, roles }) => {
      const result = await signIn('generic', {
        username: email,
        password,
        callbackUrl: '/overview',
        redirect: false,
      });

      if (!result || result.error || !result.ok) {
        return {
          success: false,
          error: {
            message: 'Login failed',
            name: 'Invalid email or password',
          },
        };
      }

      if (config.coreTransport === 'server') {
        const session = await getSession();
        if (!session?.user?.roles?.some((role) => role === 'admin' || role === 'operator')) {
          return {
            success: false,
            error: { name: 'Authentication Error', message: 'Operator session required' },
          };
        }
        localStorage.removeItem(tokenKey);
        saveUser({ ...genericAdminUser, email, roles: session.user.roles });
        window.location.href = result.url || '/overview';
        return { success: true, redirectTo: '/overview' };
      }
      const chosenRoles: string[] = roles?.length ? roles : ['admin'];
      // Only returns in localDevMode where the route is registered
      const token = await fetchDevToken(chosenRoles);
      if (token) {
        saveToken(token);
      }
      saveUser({ ...genericAdminUser, email, roles: chosenRoles });

      window.location.href = result.url || '/overview';
      return {
        success: true,
        redirectTo: '/overview',
      };
    },

    logout: async () => {
      if (config.coreTransport === 'server') await signOut({ redirect: false });
      localStorage.removeItem(tokenKey);
      localStorage.removeItem(userKey);

      return {
        success: true,
        redirectTo: '/login',
      };
    },

    check: async () => {
      if (config.coreTransport === 'server') {
        const session = await getSession();
        const authenticated =
          !session?.error &&
          session?.user?.roles?.some((role) => role === 'admin' || role === 'operator');
        return authenticated
          ? { authenticated: true }
          : { authenticated: false, redirectTo: '/login', logout: true };
      }
      const token = await getToken();

      if (token && !sessionChecked) {
        sessionChecked = true;
        if (await isStaleDevSession(token)) {
          localStorage.removeItem(tokenKey);
          localStorage.removeItem(userKey);
          return {
            authenticated: false,
            redirectTo: '/login',
            logout: true,
            error: { message: 'Session expired', name: 'Authentication Error' },
          };
        }
      }

      if (token || getUser()) {
        return {
          authenticated: true,
        };
      }

      console.warn('❌ Not authenticated, should redirect to /login');
      return {
        authenticated: false,
        redirectTo: '/login',
        logout: true,
        error: {
          message: 'Not authenticated',
          name: 'Authentication Error',
        },
      };
    },

    onError: async (error) => {
      console.log(`Authprovider: onError triggered, error: ${error}`);
      // Only logout for auth errors, not schema validation errors
      if (error.statusCode === 401) {
        return {
          logout: true,
        };
      }

      // For other errors, just return an error without logging out
      return {
        error: {
          message: error.message,
          name: error.name,
        },
      };
    },

    getIdentity: async () => {
      if (config.coreTransport === 'server') {
        const session = await getSession();
        if (!session?.user?.sub) return null;
        return {
          id: session.user.sub,
          name: session.user.name ?? 'Admin User',
          email: session.user.email ?? undefined,
          roles: session.user.roles ?? [],
        };
      }
      const user = getUser();
      if (!user) return null;
      return user;
    },

    getPermissions,

    // AuthenticationContextProvider methods

    getToken,
    getUserRole,
    getHasuraHeaders,
    getInitialized: async (): Promise<boolean> => true,
    getLoginPage: () => LoginPage,
  };
};
