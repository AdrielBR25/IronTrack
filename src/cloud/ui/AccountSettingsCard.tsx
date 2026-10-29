// Cartão "Conta" em Ajustes (Prompt 21; só com VITE_ACCOUNTS=on).
import { Link } from 'react-router-dom';
import { Cloud, HardDrive } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ACCOUNTS_ENABLED } from '../config';
import { useAccountPointer } from '../accountPointer';
import { SyncStatusChip } from './SyncStatusChip';

export function AccountSettingsCard() {
  const p = useAccountPointer();
  if (!ACCOUNTS_ENABLED) return null;
  if (p?.mode === 'account')
    return (
      <Card className="mb-4" data-testid="account-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Cloud className="h-4 w-4" aria-hidden /> Conta
          </CardTitle>
          <CardDescription>
            {p.name} · {p.email}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Button size="sm" asChild>
            <Link to="/conta">Minha conta</Link>
          </Button>
          <SyncStatusChip />
        </CardContent>
      </Card>
    );
  return (
    <Card className="mb-4" data-testid="account-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HardDrive className="h-4 w-4" aria-hidden /> Usando sem conta
        </CardTitle>
        <CardDescription>Os dados ficam só neste navegador. Com uma conta, eles ficam guardados na nuvem e aparecem nos seus outros aparelhos.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button size="sm" asChild>
          <Link to="/conta/entrar">Entrar</Link>
        </Button>
        <Button size="sm" variant="secondary" asChild>
          <Link to="/conta/criar">Criar conta</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
