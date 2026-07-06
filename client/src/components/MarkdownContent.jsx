import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const ROOT_CLASS = [
  'max-w-none text-sm leading-relaxed text-slate-800 dark:text-gray-100',
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
  '[&_li>p:first-child]:mt-0 [&_li>p:last-child]:mb-0',
].join(' ');

export function MarkdownContent({ children }) {
  return (
    <div className={ROOT_CLASS}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        p: ({ children: kids }) => <p className="my-2 leading-relaxed">{kids}</p>,
        ul: ({ children: kids }) => <ul className="my-2 ml-1 list-disc space-y-1 pl-5 marker:text-slate-500 dark:marker:text-gray-500">{kids}</ul>,
        ol: ({ children: kids }) => <ol className="my-2 ml-1 list-decimal space-y-1 pl-5 marker:text-slate-500 dark:marker:text-gray-500">{kids}</ol>,
        li: ({ children: kids }) => <li className="pl-1 leading-relaxed">{kids}</li>,
        strong: ({ children: kids }) => <strong className="font-semibold text-slate-950 dark:text-gray-50">{kids}</strong>,
        h1: ({ children: kids }) => <h1 className="mb-2 mt-4 text-base font-semibold leading-snug text-slate-950 dark:text-gray-50">{kids}</h1>,
        h2: ({ children: kids }) => <h2 className="mb-2 mt-4 text-sm font-semibold leading-snug text-slate-950 dark:text-gray-50">{kids}</h2>,
        h3: ({ children: kids }) => <h3 className="mb-1.5 mt-3 text-sm font-semibold leading-snug text-slate-950 dark:text-gray-50">{kids}</h3>,
        h4: ({ children: kids }) => <h4 className="mb-1.5 mt-3 text-xs font-semibold uppercase tracking-wide text-slate-700 dark:text-gray-300">{kids}</h4>,
        a: ({ href, children: kids }) => <a href={href} target="_blank" rel="noreferrer" className="text-blue-700 underline underline-offset-2 hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200">{kids}</a>,
        blockquote: ({ children: kids }) => <blockquote className="my-2 border-l-2 border-slate-300 pl-3 text-slate-600 dark:border-gray-600 dark:text-gray-300">{kids}</blockquote>,
        hr: () => <div className="my-3 border-t border-slate-200 dark:border-gray-700" />,
        table: ({ children: kids }) => <div className="my-2 overflow-x-auto"><table className="min-w-full border-collapse text-xs">{kids}</table></div>,
        th: ({ children: kids }) => <th className="border border-slate-300 px-2 py-1 text-left font-semibold text-slate-950 dark:border-gray-700 dark:text-gray-100">{kids}</th>,
        td: ({ children: kids }) => <td className="border border-slate-300 px-2 py-1 align-top dark:border-gray-700">{kids}</td>,
        // react-markdown v10 removed the `inline` prop. Fenced/indented code is
        // wrapped in <pre> (styled below) and its <code> carries a language-*
        // className or a trailing newline; anything else is inline.
        pre: ({ children: kids }) => <pre className="my-2 overflow-auto rounded-lg bg-slate-100 p-3 dark:bg-gray-900">{kids}</pre>,
        code({ className, children: kids }) {
          const isBlock = /language-/.test(className || '') || String(kids).includes('\n');
          return isBlock
            ? <code className="font-mono text-xs text-slate-800 dark:text-gray-300">{kids}</code>
            : <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs text-blue-700 dark:bg-gray-900 dark:text-blue-300">{kids}</code>;
        },
      }}>{String(children || '')}</ReactMarkdown>
    </div>
  );
}
