import 'dart:convert';
import '../api/api_client.dart';
import '../models/ambulance.dart';

class DriverAssignment {
  final bool assigned;
  final Ambulance? ambulance;
  final String? assignmentId;
  final String? emergencyId;
  final String? status;

  DriverAssignment({
    required this.assigned,
    this.ambulance,
    this.assignmentId,
    this.emergencyId,
    this.status,
  });

  factory DriverAssignment.fromJson(Map<String, dynamic> json) {
    return DriverAssignment(
      assigned: json['assigned'] as bool,
      ambulance: json['ambulance'] != null
          ? Ambulance.fromJson(json['ambulance'] as Map<String, dynamic>)
          : null,
      assignmentId: (json['assignment'] as Map<String, dynamic>?)?['id']
          ?.toString(),
      emergencyId: (json['assignment'] as Map<String, dynamic>?)?['emergencyId']
          ?.toString(),
      status: (json['assignment'] as Map<String, dynamic>?)?['status']
          ?.toString(),
    );
  }
}

class DriverService {
  final ApiClient _api;

  DriverService({ApiClient? api}) : _api = api ?? ApiClient();

  Future<DriverAssignment> getAssignment() async {
    final response = await _api.get('/api/drivers/me/assignment');
    if (response.statusCode == 200) {
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      return DriverAssignment.fromJson(data);
    }
    throw Exception('Failed to get assignment (HTTP ${response.statusCode}).');
  }

  Future<String> respondToAssignment(
    String assignmentId, {
    required bool accept,
    String? reason,
  }) async {
    final suffix = accept ? 'accept' : 'decline';
    final response = await _api.post(
      '/api/drivers/me/assignment/$assignmentId/$suffix',
      reason == null ? {} : {'reason': reason},
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw Exception(
        'Assignment decision failed (HTTP ${response.statusCode}).',
      );
    }
    final data = jsonDecode(response.body) as Map<String, dynamic>;
    return (data['assignment'] as Map<String, dynamic>)['status'].toString();
  }

  Future<List<DriverRoute>> getRoutes() async {
    final response = await _api.get('/api/drivers/me/routes');
    if (response.statusCode != 200) {
      throw Exception(
        'Failed to load dispatched route (HTTP ${response.statusCode}).',
      );
    }
    final data = jsonDecode(response.body) as Map<String, dynamic>;
    return (data['routes'] as List<dynamic>? ?? [])
        .map((item) => DriverRoute.fromJson(item as Map<String, dynamic>))
        .toList();
  }
}
