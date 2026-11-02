from corridor_generator import CorridorGenerator
from geofence import Geofence
from user_detection import UserDetection
from alert_manager import AlertManager


def main():

    print("=" * 55)
    print("       MODULE 9 - EMERGENCY CORRIDOR & ALERTS")
    print("=" * 55)

    # -----------------------------------------------
    # SIMULATED INPUT FROM MODULE 8
    # -----------------------------------------------

    module_8_response = {
        "ambulance_id": "AMB001",
        "route": [
            (9.7150, 76.6850),
            (9.7160, 76.6860),
            (9.7170, 76.6870)
        ]
    }

    # Simulated users near the ambulance route
    users = [
        {
            "user_id": "U001",
            "latitude": 9.7155,
            "longitude": 76.6855
        },
        {
            "user_id": "U002",
            "latitude": 9.7200,
            "longitude": 76.6900
        },
        {
            "user_id": "U003",
            "latitude": 9.7165,
            "longitude": 76.6865
        }
    ]

    # -----------------------------------------------
    # CREATE MODULE 9 COMPONENTS
    # -----------------------------------------------

    corridor_generator = CorridorGenerator()
    geofence = Geofence()
    user_detection = UserDetection()
    alert_manager = AlertManager()

    # -----------------------------------------------
    # CREATE EMERGENCY CORRIDOR
    # -----------------------------------------------

    corridor = corridor_generator.create_corridor(
        module_8_response["route"]
    )

    print("\nEmergency corridor created.")

    # -----------------------------------------------
    # DETECT USERS
    # -----------------------------------------------

    nearby_users = user_detection.find_users_inside_corridor(
        users,
        corridor,
        geofence
    )

    print("Nearby users detected:", len(nearby_users))

    # -----------------------------------------------
    # CREATE ALERTS
    # -----------------------------------------------

    alerts = alert_manager.create_alerts(
        nearby_users,
        module_8_response["ambulance_id"]
    )

    print("\nEmergency Alerts:")

    for alert in alerts:
        print(
            f"User {alert['user_id']}: "
            f"{alert['message']}"
        )

    print("\nModule 9 completed.")
    print("=" * 55)


if __name__ == "__main__":
    main()