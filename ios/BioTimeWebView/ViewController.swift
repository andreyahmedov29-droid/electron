//
//  ViewController.swift
//  BioTime WebView
//
//  Native iOS wrapper around the BioTime PWA — a direct analogue of the
//  Android WebView wrapper. It opens the app URL full-screen (no address bar),
//  keeps the platform login session via WKWebView cookies, and handles the
//  iOS safe areas (notch / Dynamic Island / home indicator).
//

import UIKit
import WebKit

class ViewController: UIViewController {

    // Адрес BIOTIME-приложения. Держите синхронно с LocationTracker.baseURL
    // (он используется фоновым трекером для отправки координат).
  private let appURL = URL(string: "https://app-2660de1a180b.vibecode.bitrix24.tech")!

    private var webView: WKWebView!

    private let activityView = UIActivityIndicatorView(style: .large)

    override func viewDidLoad() {
        super.viewDidLoad()

        configureWebView()
        configureLayout()
        loadApp()

        // Реагируем на возврат из фона — подтягиваем свежую сессию/страницу.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
    }

    private func configureWebView() {
        let configuration = WKWebViewConfiguration()
        // Фон как у приложения (тёмный) — чтобы не мигало белым при загрузке.
        // WKWebView сам загружает https (ATS разрешает доступ к нашему поддомену),
        // никакой перехват URL-схем не нужен.

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.backgroundColor = UIColor(named: "AppBackground") ?? .black
        webView.isOpaque = false
        webView.allowsBackForwardNavigationGestures = true
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
    }

    private func configureLayout() {
        // WebView растягивается на весь экран, но не заезжает под статус-бар/иконку,
        // чтобы кнопки в шапке приложения были тапабельны.
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
        ])

        // Индикатор загрузки.
        activityView.hidesWhenStopped = true
        activityView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(activityView)
        NSLayoutConstraint.activate([
            activityView.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            activityView.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }

    private func loadApp() {
        var request = URLRequest(url: appURL)
        request.cachePolicy = .returnCacheDataElseLoad
        webView.load(request)
    }

    @objc private func appDidBecomeActive() {
        // При возврате из фона можно подгрузить актуальную версию.
        if webView.url == nil {
            loadApp()
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }
}

// MARK: - WKNavigationDelegate

extension ViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView,
                 didStartProvisionalNavigation navigation: WKNavigation!) {
        activityView.startAnimating()
    }

    func webView(_ webView: WKWebView,
                 didFinish navigation: WKNavigation!) {
        activityView.stopAnimating()
    }

    func webView(_ webView: WKWebView,
                 didFail navigation: WKNavigation!,
                 withError error: Error) {
        activityView.stopAnimating()
        presentError(error, url: webView.url)
    }

    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        activityView.stopAnimating()
        presentError(error, url: appURL)
    }

    private func presentError(_ error: Error, url: URL?) {
        // Сеть/шлюз недоступен — показываем краткое сообщение с кнопкой «Повторить».
        let alert = UIAlertController(
            title: "Не удалось открыть приложение",
            message: "Проверьте подключение и повторите попытку.\n\n(\(error.localizedDescription))",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Повторить", style: .default) { [weak self] _ in
            self?.loadApp()
        })
        alert.addAction(UIAlertAction(title: "OK", style: .cancel, handler: nil))
        present(alert, animated: true)
    }
}

// MARK: - WKUIDelegate

extension ViewController: WKUIDelegate {
    // Открываем новые окна (target=_blank) внутри того же WebView.
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil {
            webView.load(navigationAction.request)
        }
        return nil
    }
}
