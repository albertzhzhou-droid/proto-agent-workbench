import { Component, type ErrorInfo, type ReactNode } from "react";

interface VisualizationErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
  resetKey: string;
}

interface VisualizationErrorBoundaryState {
  failed: boolean;
}

/** Keep a third-party renderer failure inside its own product-view pane. */
export class VisualizationErrorBoundary extends Component<VisualizationErrorBoundaryProps, VisualizationErrorBoundaryState> {
  state: VisualizationErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): VisualizationErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // The fallback is intentionally local and contains no untrusted error text.
  }

  componentDidUpdate(previousProps: VisualizationErrorBoundaryProps) {
    if (this.state.failed && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
