import {
  Component,
  Suspense,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import { isPageResourceError } from "./page-resource-loader";
import "./page-resource-boundary.css";

function ReloadPage() {
  return (
    <button type="button" onClick={() => window.location.reload()}>
      重新加载页面
    </button>
  );
}

function PageLoading() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 12000);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <section
      className="page-resource-state"
      data-state={slow ? "slow" : "loading"}
      role="status"
      aria-live="polite"
    >
      <span className="page-resource-spinner" aria-hidden="true" />
      <strong>{slow ? "页面加载较慢" : "正在加载页面"}</strong>
      {slow && (
        <>
          <p>可以继续等待，或检查网络。重新加载前请先保留未保存的内容。</p>
          <ReloadPage />
        </>
      )}
    </section>
  );
}

class ResourceErrorBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(
    previous: Readonly<{ children: ReactNode; resetKey: string }>,
  ) {
    if (previous.resetKey !== this.props.resetKey && this.state.error)
      this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    const failedResource = isPageResourceError(this.state.error);
    return (
      <section className="page-resource-state" data-state="error" role="alert">
        <strong>
          {failedResource ? "页面资源加载失败" : "页面暂时无法显示"}
        </strong>
        <p>
          {failedResource
            ? "网络中断或网站版本更新可能导致此问题。"
            : "当前页面遇到问题，可以先切换到其他页面。"}
          重新加载前请先保留未保存的内容。
        </p>
        <ReloadPage />
      </section>
    );
  }
}

/** Route failures must not hide navigation or silently reload unsaved work. */
export function PageResourceBoundary({
  children,
  routeContent = false,
}: {
  children: ReactNode;
  routeContent?: boolean;
}) {
  const location = useLocation();
  const route = location.pathname + location.search;
  return (
    <ResourceErrorBoundary resetKey={route}>
      <Suspense
        key={routeContent ? location.pathname : undefined}
        fallback={<PageLoading key={route} />}
      >
        {children}
      </Suspense>
    </ResourceErrorBoundary>
  );
}
