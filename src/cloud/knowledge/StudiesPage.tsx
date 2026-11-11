// Estudos (Fase 04): matérias com meta semanal, tempo e tópicos. Simples de propósito: matéria → tópicos → sessões.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Plus } from 'lucide-react';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useLifeQuery } from '../life/api';
import { knowledgeApi } from './api';
import { SubjectDialog } from './forms';
import { SubjectRow, fmtMin } from './ui';

export default function StudiesPage() {
  const q = useLifeQuery(() => knowledgeApi.subjects().then((r) => r.subjects));
  const [add, setAdd] = useState(false);
  const list = q.data ?? [];
  const week = list.reduce((s, x) => s + x.minutesWeek, 0);
  return (
    <div className="space-y-4 pb-10" data-testid="knowledge-studies">
      <PageHeader
        title="Estudos"
        subtitle={list.length ? `${fmtMin(week)} nesta semana` : undefined}
        action={
          <Link to="/conhecimento" className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Voltar para Conhecimento">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
      />
      <Button className="w-full" onClick={() => setAdd(true)} data-testid="subject-add">
        <Plus className="h-4 w-4" />
        Nova matéria
      </Button>
      {q.data && list.length === 0 ? (
        <p className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">Crie uma matéria (ex.: Programação, Inglês) e registre o tempo de estudo com o cronômetro.</p>
      ) : (
        <Card>
          <CardContent className="divide-y divide-border/60 px-4 py-1">
            {list.map((s) => (
              <SubjectRow key={s.id} s={s} />
            ))}
          </CardContent>
        </Card>
      )}
      <SubjectDialog open={add} onOpenChange={setAdd} />
    </div>
  );
}
