try {
  if (navigator.webdriver) {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => false,
      configurable: true,
    });
  }
} catch {
  // ignore
}
