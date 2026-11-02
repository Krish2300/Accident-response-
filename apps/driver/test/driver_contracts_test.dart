import 'dart:convert';

import 'package:driver_app/api/api_client.dart';
import 'package:driver_app/services/driver_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(
    () =>
        SharedPreferences.setMockInitialValues({'auth_token': 'driver-token'}),
  );

  test(
    'reads assignment id, status and ambulance from authenticated response',
    () async {
      late http.Request observed;
      final client = MockClient((request) async {
        observed = request;
        return http.Response(
          jsonEncode({
            'assigned': true,
            'assignment': {
              'id': 'ASG-1',
              'emergencyId': 'EMG-1',
              'status': 'ASSIGNED',
              'expiresAt': '2026-10-27T12:00:00.000Z',
            },
            'ambulance': {
              'id': 'AMB-1',
              'vehicleNumber': 'KA-01',
              'status': 'ASSIGNED',
            },
          }),
          200,
        );
      });
      final service = DriverService(api: ApiClient(client: client));

      final result = await service.getAssignment();

      expect(observed.url.path, '/api/drivers/me/assignment');
      expect(observed.headers['authorization'], 'Bearer driver-token');
      expect(result.assignmentId, 'ASG-1');
      expect(result.emergencyId, 'EMG-1');
      expect(result.status, 'ASSIGNED');
      expect(result.expiresAt, '2026-10-27T12:00:00.000Z');
      expect(result.ambulance?.id, 'AMB-1');
    },
  );

  test(
    'posts explicit accept or decline decisions and reads only dispatched route data',
    () async {
      final requests = <http.Request>[];
      final client = MockClient((request) async {
        requests.add(request);
        if (request.url.path.endsWith('/accept')) {
          return http.Response(
            jsonEncode({
              'assignment': {'status': 'ACCEPTED'},
            }),
            200,
          );
        }
        if (request.url.path.endsWith('/decline')) {
          return http.Response(
            jsonEncode({
              'assignment': {'status': 'DECLINED'},
            }),
            200,
          );
        }
        return http.Response(
          jsonEncode({
            'routes': [
              {
                'id': 'RTE-1',
                'destinationName': 'SCENE',
                'distanceKm': 4.2,
                'estimatedMinutes': 6,
                'provider': 'deterministic',
                'isLiveTraffic': false,
                'isSimulation': true,
                'polyline': [
                  [12.9, 77.5],
                  [12.91, 77.51],
                ],
              },
            ],
          }),
          200,
        );
      });
      final service = DriverService(api: ApiClient(client: client));

      expect(
        await service.respondToAssignment('ASG-1', accept: true),
        'ACCEPTED',
      );
      expect(
        await service.respondToAssignment(
          'ASG-1',
          accept: false,
          reason: 'not available',
        ),
        'DECLINED',
      );
      final routes = await service.getRoutes();

      expect(requests[0].url.path, '/api/drivers/me/assignment/ASG-1/accept');
      expect(requests[1].url.path, '/api/drivers/me/assignment/ASG-1/decline');
      expect(jsonDecode(requests[1].body), {'reason': 'not available'});
      expect(requests[2].url.path, '/api/drivers/me/routes');
      expect(routes.single.isLiveTraffic, isFalse);
      expect(routes.single.polyline, hasLength(2));
    },
  );

  test(
    'surfaces authorization errors instead of treating a failed response as success',
    () async {
      final service = DriverService(
        api: ApiClient(
          client: MockClient((_) async => http.Response('forbidden', 403)),
        ),
      );
      await expectLater(service.getRoutes(), throwsA(isA<Exception>()));
    },
  );
}
