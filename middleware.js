import { NextResponse } from 'next/server';

/**
 * Basic authentication middleware.
 * Set DASHBOARD_PASSWORD env var to enable password protection.
 * If not set, the dashboard is publicly accessible.
 */
export function middleware(request) {
  const password = process.env.DASHBOARD_PASSWORD;

  // If no password is configured, allow access
  if (!password) {
    return NextResponse.next();
  }

  const authHeader = request.headers.get('authorization');

  if (authHeader) {
    const [scheme, encoded] = authHeader.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = atob(encoded);
      const [, pwd] = decoded.split(':');
      if (pwd === password) {
        return NextResponse.next();
      }
    }
  }

  return new NextResponse('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Dashboard"',
    },
  });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
