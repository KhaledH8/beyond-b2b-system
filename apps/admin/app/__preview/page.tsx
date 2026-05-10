import { notFound } from 'next/navigation';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Input } from '../../components/Input';
import { Textarea } from '../../components/Textarea';

// Dev-only: not reachable in production.
// Does not appear in the operator navigation — it is a raw URL.
export default function PreviewPage() {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }

  return (
    <main className="mx-auto max-w-3xl space-y-10 px-6 py-10">
      <h1 className="text-2xl font-bold text-gray-900">
        Component preview — dev only
      </h1>

      {/* Button */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-gray-700">Button</h2>
        <div className="flex flex-wrap gap-3">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="ghost">Ghost</Button>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" size="sm">
            Primary sm
          </Button>
          <Button variant="secondary" size="sm">
            Secondary sm
          </Button>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" disabled>
            Primary disabled
          </Button>
          <Button variant="danger" disabled>
            Danger disabled
          </Button>
        </div>
      </section>

      {/* Input */}
      <section className="max-w-sm space-y-4">
        <h2 className="text-lg font-semibold text-gray-700">Input</h2>
        <Input label="Email" type="email" placeholder="operator@bb.test" />
        <Input
          label="With helper"
          helperText="Use your work email."
          placeholder="..."
        />
        <Input
          label="With error"
          errorText="This field is required."
          placeholder="..."
        />
        <Input label="Disabled" disabled placeholder="Can't touch this" />
      </section>

      {/* Textarea */}
      <section className="max-w-sm space-y-4">
        <h2 className="text-lg font-semibold text-gray-700">Textarea</h2>
        <Textarea label="Notes" placeholder="Write something..." />
        <Textarea
          label="With helper"
          helperText="Max 500 characters."
          placeholder="..."
        />
        <Textarea
          label="With error"
          errorText="Notes are required."
          placeholder="..."
        />
        <Textarea label="Disabled" disabled placeholder="Read-only" />
      </section>

      {/* Card */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-gray-700">Card</h2>
        <Card title="Card with title">
          <p className="text-sm text-gray-600">This is the card content.</p>
        </Card>
        <Card>
          <p className="text-sm text-gray-600">Card without title.</p>
        </Card>
      </section>

      {/* Banner */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-gray-700">Banner</h2>
        <Banner variant="info">This is an informational banner.</Banner>
        <Banner variant="warning">
          Warning — review before proceeding.
        </Banner>
        <Banner variant="danger">
          Danger — this action cannot be undone.
        </Banner>
      </section>
    </main>
  );
}
