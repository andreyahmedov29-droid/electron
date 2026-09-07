//
//  LocationTracker.swift
//  BioTime WebView
//
//  Нативный фоновый трекер геолокации водителя — iOS-аналог Android-обёртки.
//  Собирает координаты через CLLocationManager и отправляет их на готовый
//  эндпоинт BIOTIME POST /api/drivers/location. Работает и в фоне, когда
//  WebView свёрнут/экрана нет (при включённом фоновом доступе к геолокации).
//

import CoreLocation
import Foundation

final class LocationTracker: NSObject, CLLocationManagerDelegate {

    static let shared = LocationTracker()

    /// Адрес BIOTIME-приложения — тот же, что открывает WebView.
    /// Держите синхронно с ViewController.appURL.
  private let baseURL = "https://app-2660de1a180b.vibecode.bitrix24.tech"
    private let updateInterval: TimeInterval = 15 // секунды, как в Android-обёртке

    private let manager = CLLocationManager()
    private var lastSentAt: Date = .distantPast

    private override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        // Разрешаем обновления, когда приложение в фоне, и запрещаем системе
        // останавливать их автоматически (иначе трек «замирает»).
        manager.allowsBackgroundLocationUpdates = true
        manager.pausesLocationUpdatesAutomatically = false
    }

    /// Вызывается при старте: запрашиваем доступ и запускаем трекинг.
    func start() {
        switch manager.authorizationStatus {
        case .authorizedAlways:
            manager.startUpdatingLocation()
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        default:
            // .denied / .restricted / .authorizedWhenInUse — попробуем апгрейд до always
            manager.requestAlwaysAuthorization()
        }
    }

    // MARK: - CLLocationManagerDelegate

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedAlways:
            manager.startUpdatingLocation()
        case .authorizedWhenInUse:
            // Пытаемся получить «always» для фоновой работы.
            manager.requestAlwaysAuthorization()
        default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last,
              loc.coordinate.latitude.isFinite,
              loc.coordinate.longitude.isFinite else { return }

        let now = Date()
        guard now.timeIntervalSince(lastSentAt) >= updateInterval else { return }
        lastSentAt = now

        send(lat: loc.coordinate.latitude, lon: loc.coordinate.longitude)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Геолокация временно недоступна — следующее обновление догонит.
    }

    // MARK: - Отправка координат

    private func send(lat: Double, lon: Double) {
        let body: [String: Any] = ["lat": lat, "lon": lon, "routeId": ""]
        guard let payload = try? JSONSerialization.data(withJSONObject: body),
              let url = URL(string: baseURL + "/api/drivers/location") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = payload

        // Фоновая сессия, чтобы запрос добрался до сервера, даже когда
        // приложение свёрнуто. Отдельный идентификатор на каждую отправку.
        let config = URLSessionConfiguration.background(
            withIdentifier: "biotime.location.\(Int(Date().timeIntervalSince1970 * 1000))"
        )
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        let session = URLSession(configuration: config)

        let task = session.dataTask(with: request)
        task.resume()
    }
}
